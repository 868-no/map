/// <reference lib="webworker" />
// Derivation worker: holds the browser's copy of the packet log in the
// WebAssembly engine and builds every view from it, off the main thread
// (D-031, D-040). Rows travel as JSON text straight into the engine; views
// come back as UTF-8 JSON bytes, handed to the page as transferables.
import init, { Engine } from '../engine/pkg/engine.js'
// Content-hashed in builds: names this engine build for the saved row copy (D-102).
import engineUrl from '../engine/pkg/engine_bg.wasm?url'
// The map's Regions layer outlines (content-hashed), for health's topic-root rule (D-161).
import regionsUrl from '../assets/regions.geojson?url'
import { gunzip, openPersistence, type Persistence, type Source } from './persist'
import { baseParams, RowStore, type Backend, type Synced, type WindowReq } from './rowStore'
import { debounce, rebuildDelay } from './debounce'
import { RangeFetcher } from './range'
import type { Request, Response, Transmission, ViewRequest } from './protocol'
import { ViewError, type ViewMeta } from './views'
import { ViewMemo } from './memo'

const ready = init({ module_or_path: engineUrl })
// The saved copy is opened while the engine instantiates (it needs no engine).
const opened = openPersistence(engineUrl).catch(() => null)
let engine: Engine
let store: RowStore<number, string>
let persist: Persistence | null = null

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
    engine.keep_only(lo, hi)
  }
  newestT() {
    return engine.newest_t()
  }
  count() {
    return engine.count()
  }
}

const fetcher = new RangeFetcher(() => engine)

const source: Source = {
  takeDirty: () => Array.from(engine.take_dirty()),
  exportRange: (lo, hi) => engine.export(lo, hi),
  newestT: () => engine.newest_t(),
}
const flushSoon = debounce(() => void persist?.flush(source), 2000, 5000)

const started = (async () => {
  await ready
  engine = new Engine()
  store = new RowStore(new EngineRows(), fetcher.fetchRange)
  persist = await opened
  if (persist) {
    // One chunk decompressed at a time, straight into the engine: the history
    // is never held as text all at once, nor kept in the worker's heap (§9).
    try {
      for (const chunk of persist.restored.chunks) engine.add_rows(await gunzip(chunk), -Infinity)
    } catch {
      // An unreadable copy is no copy: start afresh.
      engine.reset()
      persist.reset()
      persist.restored.cov = null
      persist.restored.generation = null
    }
    persist.restored.chunks = []
    engine.take_dirty() // restored rows are already stored
    persist.attach(source)
    store.load(persist.restored.cov, persist.restored.generation)
    const p = persist
    store.sink = {
      changed: flushSoon,
      removedBefore: (t) => p.removedBefore(t, source),
      reset: () => p.reset(),
      // Rows first, then the coverage record that describes them.
      meta: (cov, generation) => {
        void p.flush(source)
        p.meta(cov, generation)
      },
    }
  }
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

// One sync at a time; repeated requests for the same window and epoch share it.
let chain: Promise<unknown> = Promise.resolve()
let last: { key: string; result: Promise<{ synced: Synced; offline: boolean }> } | null = null
let pendingLive: string[] = [] // streamed before the first sync established coverage

// Whole days of the first window are fetched as soon as the page has passed
// the server's generation (from /retention) and asked for a window, while the
// engine instantiates; the first sync takes them (D-170). Not when the saved
// copy is of that generation: the store then asks only for what is new.
let firstWin: WindowReq | null = null
let prefetched = false
let syncing = false // the first sync began: the store asks for itself
async function prefetch() {
  if (prefetched || syncing || !firstWin || !fetcher.hint) return
  prefetched = true
  const held = (await opened)?.restored
  if (syncing || (held?.cov && held.generation === fetcher.hint)) return
  fetcher.prefetchDays(baseParams(firstWin))
}
function synced(win: WindowReq, epoch: string): Promise<{ synced: Synced; offline: boolean }> {
  const key = JSON.stringify(win) + '|' + epoch
  if (last?.key === key) return last.result
  const result = chain.then(async () => {
    await started
    try {
      syncing = true
      const s = await store.sync(win).finally(() => fetcher.dropPrefetched())
      for (const rows of pendingLive) store.addLive(rows)
      pendingLive = []
      return { synced: s, offline: false }
    } catch (e) {
      if (e instanceof ViewError) throw e // the API answered, with an error (a gateway's 502/503/504 is no answer)
      const s = store.offline(win, Date.now(), quantumMs)
      if (!s) throw new ViewError('unavailable', 'offline and no saved data for this window')
      return { synced: s, offline: true }
    }
  })
  chain = result.catch(() => {})
  last = { key, result }
  // Retry next time after an error, and after an answer from the saved copy
  // (the API may answer again: a backend restart sends no 'online' event).
  const forget = () => {
    if (last?.key === key) last = null
  }
  result.then((r) => r.offline && forget(), forget)
  return result
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
      engine.set_regions(text)
      memo.forget('health')
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

async function view(req: ViewRequest): Promise<{ body: Uint8Array; meta: ViewMeta; offline: boolean }> {
  if (!firstWin) {
    firstWin = req.win
    void prefetch()
  }
  await inited
  if (startError) throw new ViewError('internal', `the derivation engine failed to start: ${startError}`)
  liveHours = req.win.live ? req.win.durationH : null
  const { synced: sy, offline } = await synced(req.win, req.epoch)
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
  if (msg.type === 'terrain') {
    try {
      await started
      await inited
      engine.set_terrain(JSON.stringify(msg.links))
      memo.clear()
      self.postMessage({ type: 'changed' } satisfies Response)
    } catch (err) {
      if (!fatal(err)) console.warn('terrain classes dropped', err)
    }
    return
  }
  if (msg.type === 'options') {
    try {
      await started
      await inited
      engine.set_options(JSON.stringify({ max_nodes: msg.maxNodes }))
      memo.clear()
      self.postMessage({ type: 'changed' } satisfies Response)
    } catch (err) {
      if (!fatal(err)) console.warn('options dropped', err)
    }
    return
  }
  if (msg.type === 'init') {
    try {
      await started
      engine.set_options(JSON.stringify({ geo: msg.geo }))
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
  let out: Response
  const transfer: Transferable[] = []
  try {
    const { body, meta, offline } = await view(msg)
    const bytes = body.slice() // the memo keeps the original; the copy is transferred
    transfer.push(bytes.buffer)
    out = { id: msg.id, ok: true, body: bytes, meta, offline }
  } catch (err) {
    fatal(err)
    out = { id: msg.id, ok: false, kind: err instanceof ViewError ? err.kind : 'internal', message: err instanceof Error ? err.message : String(err) }
  }
  self.postMessage(out, transfer)
}
