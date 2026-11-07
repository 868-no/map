/// <reference lib="webworker" />
// Derivation worker: holds the browser's copy of the packet log in the
// WebAssembly engine and builds every view from it, off the main thread
// (D-031, D-040). Rows travel as JSON text straight into the engine; views
// come back as UTF-8 JSON bytes, handed to the page as transferables.
import init, { Engine, __wbg_reset_state as newInstance } from '../engine/pkg/engine.js'
// Content-hashed in builds, so a new engine is fetched with each deploy that changes it.
import engineUrl from '../engine/pkg/engine_bg.wasm?url'
// The map's Regions layer outlines (content-hashed), for health's topic-root rule (D-161).
import regionsUrl from '../assets/regions.geojson?url'
import { openCache } from './cache'
import { baseParams, RowStore, type Backend, type Synced, type WindowReq } from './rowStore'
import { debounce, rebuildDelay } from './debounce'
import { RangeFetcher } from './range'
import type { Request, Response, Transmission, ViewRequest } from './protocol'
import { ViewError, type ViewMeta } from './views'
import { ViewMemo } from './memo'

const ready = init({ module_or_path: engineUrl })
// The read-through cache (D-184) is opened while the engine instantiates (it needs no engine).
const opened = openCache().catch(() => null)
let engine: Engine
let store: RowStore<number, string>

// What the engine was told, so a fresh instance is told the same.
const options: Record<string, unknown> = {}
let terrain: string | null = null
let regions: string | null = null
function setOptions(o: Record<string, unknown>) {
  engine.set_options(JSON.stringify(o))
  // As the engine merges them: a field left out (or undefined, so not sent) keeps its value.
  for (const [k, v] of Object.entries(o)) if (v !== undefined) options[k] = v
}
function setTerrain(json: string) {
  engine.set_terrain(json)
  terrain = json
}
function setRegions(text: string) {
  engine.set_regions(text)
  regions = text
}

/** Rows copied to a fresh instance per export: a few hours at a time, never the whole range as one string. */
const COPY_SPAN_MS = 6 * 3_600_000

/**
 * Keeps only the rows in [lo, hi) in a new WebAssembly instance. Its memory
 * only grows, so dropping rows frees nothing to the browser; a new instance
 * starts small, and the old one's memory goes when it is collected. Every
 * Engine of the old instance is unusable afterwards (wasm-bindgen's
 * --experimental-reset-state-function).
 */
function freshEngine(lo: number, hi: number) {
  const end = Math.min(hi, engine.newest_t() + 1)
  const parts: string[] = []
  for (let t = lo; t < end; t += COPY_SPAN_MS) parts.push(engine.export(t, Math.min(t + COPY_SPAN_MS, end)))
  newInstance()
  engine = new Engine()
  if (Object.keys(options).length) engine.set_options(JSON.stringify(options))
  if (terrain) engine.set_terrain(terrain)
  if (regions) engine.set_regions(regions)
  for (const p of parts) engine.add_rows(p, -Infinity)
  // Views of the old instance are keyed by its revisions, which the new one counts afresh.
  memo.clear()
  pinned.clear()
}

/** The engine as the row store's backend: batches are staged page ids, live rows JSON text. */
class EngineRows implements Backend<number, string> {
  commit(batch: number) {
    return engine.commit(batch)
  }
  discard(batch: number) {
    engine.discard(batch)
  }
  addLive(rows: string, lo: number) {
    return engine.add_rows(rows, lo)
  }
  reset() {
    engine.reset()
  }
  trimBefore(t: number) {
    engine.trim_before(t)
  }
  keepOnly(lo: number, hi: number) {
    freshEngine(lo, hi)
  }
  newestT() {
    return engine.newest_t()
  }
  count() {
    return engine.count()
  }
}

const fetcher = new RangeFetcher(() => engine)

const started = (async () => {
  await ready
  engine = new Engine()
  store = new RowStore(new EngineRows(), fetcher.fetchRange, fetcher.fetchCached)
  // Nothing is loaded from the cache here: each window reads what it needs through it.
  fetcher.cache = await opened
})()

let quantumMs = 10_000
// Views wait for the operator's geolocation settings from the page.
let initDone: () => void
const inited = new Promise<void>((resolve) => (initDone = resolve))
let startError: string | null = null // the engine could not start: every view fails with it
let lastBuildMs = 0 // the last snapshot build: live rebuilds wait in proportion (rebuildDelay)

/**
 * A WebAssembly trap (a Rust panic aborts) leaves the engine unusable: every
 * later call fails. Report it so the page restarts the worker.
 */
function fatal(err: unknown): boolean {
  if (!(err instanceof WebAssembly.RuntimeError)) return false
  self.postMessage({ type: 'fatal', message: err.message } satisfies Response)
  return true
}
self.addEventListener('unhandledrejection', (e) => {
  if (fatal(e.reason)) e.preventDefault()
})

// One sync at a time; repeated requests for the same window and epoch share
// it. A sync is for the views waiting on it: once the page has given up all
// of them (a newer window, filter or node), a queued sync is skipped and a
// running one aborted, its requests with it.
interface Sync {
  key: string
  result: Promise<{ synced: Synced; offline: boolean }>
  waiters: Set<number> // ids of the views waiting on it
  abort: AbortController
}
let chain: Promise<unknown> = Promise.resolve()
let last: Sync | null = null
const waitingOn = new Map<number, Sync>() // view id → the sync it waits on
let pendingLive: string[] = [] // streamed before the first sync established coverage

// Whole days of the first window are fetched as soon as the page has passed
// the server's generation (from /retention) and asked for a window, while the
// engine instantiates; the first sync takes them (D-170). Days the cache
// holds under that generation are not fetched (D-184).
let firstWin: WindowReq | null = null
let prefetched = false
let syncing = false // the first sync began: the store asks for itself
async function prefetch() {
  if (prefetched || syncing || !firstWin || !fetcher.hint) return
  prefetched = true
  fetcher.cache = await opened
  if (syncing) return
  fetcher.prefetchDays(baseParams(firstWin))
}
function startSync(win: WindowReq, key: string): Sync {
  const abort = new AbortController()
  const signal = abort.signal
  const result = chain.then(async () => {
    if (signal.aborted) throw CANCELLED // queued, and every view waiting on it was given up
    await started
    try {
      syncing = true
      const s = await store.sync(win, Date.now(), signal).finally(() => fetcher.dropPrefetched())
      for (const rows of pendingLive) store.addLive(rows)
      pendingLive = []
      return { synced: s, offline: false }
    } catch (e) {
      if (signal.aborted) throw CANCELLED // not offline: given up
      if (e instanceof ViewError) throw e // the API answered, with an error (a gateway's 502/503/504 is no answer)
      // Nothing held yet (a cold start offline): what the cache has of the window.
      await store.fromCache(win).catch(() => false)
      const s = store.offline(win, Date.now(), quantumMs)
      if (!s) throw new ViewError('unavailable', 'offline and no saved data for this window')
      return { synced: s, offline: true }
    }
  })
  const sync: Sync = { key, result, waiters: new Set(), abort }
  chain = result.catch(() => {})
  // Retry next time after an error, and after an answer from the saved copy
  // (the API may answer again: a backend restart sends no 'online' event).
  const forget = () => {
    if (last === sync) last = null
  }
  result.then((r) => r.offline && forget(), forget)
  return sync
}

/** The window's sync, shared with other views of the same window and epoch; view `id` waits on it. */
async function synced(win: WindowReq, epoch: string, id: number): Promise<{ synced: Synced; offline: boolean }> {
  const key = JSON.stringify(win) + '|' + epoch
  if (last?.key !== key) last = startSync(win, key)
  const sync = last
  sync.waiters.add(id)
  waitingOn.set(id, sync)
  try {
    return await sync.result
  } finally {
    sync.waiters.delete(id)
    waitingOn.delete(id)
  }
}

/** The page gave up view `id`: a sync no view waits on any more is skipped, or aborted if running. */
function giveUp(id: number) {
  asked.delete(id)
  const sync = waitingOn.get(id)
  if (!sync) return
  waitingOn.delete(id)
  sync.waiters.delete(id)
  if (sync.waiters.size) return
  sync.abort.abort()
  if (last === sync) last = null // a later request for the same window starts afresh
}

// Rolling-window ends pinned per page revision (window, epoch, rev): rows
// merge as they stream in, so without the pin a view of one rebuild handled
// after more rows landed would get a later end than the snapshot of the same
// rebuild, miss the memo and show counts that disagree with it. A few recent
// keys are kept, for requests of an older revision still in flight.
const PINNED_MAX = 8
const pinned = new Map<string, number>()

/**
 * The window to build. A rolling one ends just after the newest row held (or
 * at the last sync, which runs at least once a minute): it follows the data,
 * and a streamed row counts as soon as it is merged. The end is fixed by the
 * first request of a page revision, so every view of one rebuild gets the
 * same window and shares one memoised snapshot.
 */
function bounds(req: ViewRequest, s: Synced, offline: boolean): { start: number; end: number } {
  const win = req.win
  if (!win.live || offline) return { start: s.start, end: s.end }
  const key = `${win.durationH}|${req.epoch}|${req.rev}`
  let end = pinned.get(key)
  if (end === undefined) {
    end = Math.max(s.end, engine.newest_t() + 1)
    pinned.set(key, end)
    for (const k of pinned.keys()) if (pinned.size > PINNED_MAX) pinned.delete(k) // oldest first
  }
  return { start: end - win.durationH * 3_600_000, end }
}

// Rebuild notices are debounced: views rebuild once the stream pauses, and
// at least every so often while it keeps flowing; both scale with the
// rolling window's length (rebuildDelay). Pings do not wait.
let liveHours: number | null = null // of the window last requested
const changed = debounce(
  () => self.postMessage({ type: 'changed' } satisfies Response),
  () => rebuildDelay(liveHours, lastBuildMs).quietMs,
  () => rebuildDelay(liveHours, lastBuildMs).maxMs,
)

/** Live batches kept before the first load completes (the stream sends about one a second). */
const MAX_PENDING_LIVE = 600

/** Live rows from the stream: merged, plus ping attribution for those the page wants animated. */
function liveRows(rows: unknown[], ping: number[]) {
  if (!engine) return
  const text = JSON.stringify(rows)
  if (ping.length) {
    const tx = JSON.parse(engine.transmissions(JSON.stringify(ping.map((k) => rows[k])))) as Transmission[][]
    self.postMessage({ type: 'pings', transmissions: tx.flat() } satisfies Response)
  }
  if (!store.cov) {
    // Held until the window's first load lands; bounded in case it keeps failing.
    pendingLive.push(text)
    if (pendingLive.length > MAX_PENDING_LIVE) pendingLive.splice(0, pendingLive.length - MAX_PENDING_LIVE)
    return
  }
  if (store.addLive(text)) changed()
}

// Views are memoised (as UTF-8 JSON bytes) by data revision, kind, window
// and filters; the total is capped (memo.ts).
const memo = new ViewMemo(24_000_000)

// The regions' outlines are fetched once, from the same file the map's
// Regions layer uses (HTTP-cached, content-hashed), not built into the
// engine. Health judges gateways' topic roots only once they are in; until
// then, or if every attempt fails, that one rule is skipped (D-161).
async function loadRegions() {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(regionsUrl)
      if (!res.ok) throw new Error(`regions: HTTP ${res.status}`)
      const text = await res.text()
      await started
      setRegions(text)
      memo.forget('health')
      memo.forget('regions') // regions are judged by the outlines too (D-194)
      self.postMessage({ type: 'changed' } satisfies Response)
      return
    } catch (err) {
      if (fatal(err)) return
      if (attempt === 3) console.warn('regions not loaded: topic roots go unchecked', err)
      else await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt))
    }
  }
}
void loadRegions()

const NULL = [110, 117, 108, 108] // "null"
const isNull = (b: Uint8Array) => b.length === 4 && NULL.every((c, k) => b[k] === c)

/** Views asked for and not yet answered; one the page cancelled is dropped from it. */
const asked = new Set<number>()
/** Thrown for a view cancelled before its build: no answer is sent. */
const CANCELLED = Symbol('cancelled')

async function view(req: ViewRequest): Promise<{ body: Uint8Array; meta: ViewMeta; offline: boolean }> {
  if (!firstWin) {
    firstWin = req.win
    void prefetch()
  }
  await inited
  if (startError) throw new ViewError('internal', `the derivation engine failed to start: ${startError}`)
  liveHours = req.win.live ? req.win.durationH : null
  if (!asked.has(req.id)) throw CANCELLED // given up while the worker started: no sync for it
  const { synced: sy, offline } = await synced(req.win, req.epoch, req.id)
  // Waiting on the sync is when requests pile up (start-up, a new window or
  // filter, a node clicked through): those given up are not built.
  if (!asked.has(req.id)) throw CANCELLED
  const { start, end } = bounds(req, sy, offline)
  const f = { channels: req.filters.channels, brokers: req.filters.brokers, types: req.filters.types }
  const fj = JSON.stringify(f)
  const revision = `${store.generation}.${engine.revision(start, end)}`
  // What the UI needs besides the body: the window built, and how recent the held data is.
  const meta: ViewMeta = {
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), rolling: sy.rolling },
    data_until: new Date(Math.max(store.cov?.hi ?? 0, engine.newest_t())).toISOString(),
  }
  const key = `${revision}|${start}|${end}|${fj}|${req.kind}|${req.node ?? ''}`
  let body: Uint8Array
  try {
    body = memo.remember(key, revision, req.kind, () => {
      const t0 = performance.now()
      const b = engine.view_bytes(req.kind, start, end, fj, req.node ?? '')
      if (req.kind === 'snapshot') lastBuildMs = performance.now() - t0
      return b
    })
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) throw e // a trap, not a bad request
    throw new ViewError('bad_request', e instanceof Error ? e.message : String(e))
  }
  if (isNull(body)) throw new ViewError('not_found', 'node not observed or referenced in the selected window')
  // The meta travels beside the body: the (possibly large) body is never parsed or re-encoded here.
  return { body, meta, offline }
}

/** Applies a setting every view depends on, after init, and has the page ask its views again. */
async function reconfigure(what: string, apply: () => void): Promise<void> {
  try {
    await started
    await inited
    apply()
    memo.clear()
    self.postMessage({ type: 'changed' } satisfies Response)
  } catch (err) {
    if (!fatal(err)) console.warn(`${what} dropped`, err)
  }
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const msg = e.data
  if (msg.type === 'rows') {
    try {
      await started
      liveRows(msg.rows, msg.ping)
    } catch (err) {
      if (!fatal(err)) console.warn('live rows dropped', err)
    }
    return
  }
  if (msg.type === 'generation') {
    fetcher.hint = msg.generation
    void prefetch()
    return
  }
  if (msg.type === 'terrain') return reconfigure('terrain classes', () => setTerrain(JSON.stringify(msg.links)))
  if (msg.type === 'options') return reconfigure('options', () => setOptions({ max_nodes: msg.maxNodes }))
  if (msg.type === 'init') {
    try {
      await started
      // Settings made before (or kept across) a restart come with it: one rebuild, not one each.
      setOptions({ geo: msg.geo, max_nodes: msg.maxNodes })
      if (msg.terrain?.length) setTerrain(JSON.stringify(msg.terrain))
      quantumMs = msg.liveQuantumMs
      memo.clear()
      pinned.clear()
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err)
      fatal(err)
    } finally {
      initDone() // views stop waiting: they build, or fail with startError
    }
    return
  }
  if (msg.type === 'cancel') {
    giveUp(msg.id)
    return
  }
  let out: Response
  const transfer: Transferable[] = []
  asked.add(msg.id)
  try {
    const { body, meta, offline } = await view(msg)
    const bytes = body.slice() // the memo keeps the original; the copy is transferred
    transfer.push(bytes.buffer)
    out = { id: msg.id, ok: true, body: bytes, meta, offline }
  } catch (err) {
    if (err === CANCELLED) return
    fatal(err)
    out = { id: msg.id, ok: false, kind: err instanceof ViewError ? err.kind : 'internal', message: err instanceof Error ? err.message : String(err) }
  } finally {
    asked.delete(msg.id)
  }
  self.postMessage(out, transfer)
}
