/// <reference lib="webworker" />
// Derivation worker: holds the browser's copy of the packet log in the
// WebAssembly engine and builds every view from it, off the main thread
// (D-031, D-040). Rows travel as JSON text straight into the engine; views
// come back as UTF-8 JSON bytes, handed to the page as transferables.
import init, { Engine } from '../engine/pkg/engine.js'
// Content-hashed in builds: names this engine build for the saved row copy (D-102).
import engineUrl from '../engine/pkg/engine_bg.wasm?url'
import { gunzip, openPersistence, type Persistence, type Source } from './persist'
import { RowStore, type Backend, type Fetched, type Synced, type WindowReq } from './rowStore'
import { debounce, rebuildDelay } from './debounce'
import { cursorMs, DAY_MS, dayName, limiter, planDays, rangeEnd, requestedRange, sliceBounds } from './slices'
import type { Request, Response, Transmission, ViewRequest } from './protocol'
import { ViewError, type ViewMeta } from './views'
import { backendBusy, gatewayDown, retryDelay } from './httpStatus'

const ready = init({ module_or_path: engineUrl })
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

/** Parallel requests for the rest of a range after its first page. */
const SLICES = 4
/** Requests in flight at once for one range: the server lets a client run 4 reads (API_READS_PER_CLIENT). */
const PARALLEL = 4
/** A page not answered in this long fails the range, as if offline. */
const PAGE_TIMEOUT_MS = 30_000
/** Retries of a page answered 429 or busy, each after its Retry-After (at most 10 s). */
const RATE_RETRIES = 3

/** A whole day was asked for under a generation the server no longer has (409): refetch the range. */
class GenerationMoved extends Error {}

/** GETs an API URL as text, retrying while the backend is busy; errors are typed as fetchRange's callers expect. */
async function fetchText(url: string): Promise<string> {
  let res: globalThis.Response
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) })
    } catch (e) {
      throw new Error(`observations: ${e instanceof Error ? e.message : e}`, { cause: e })
    }
    // Rate-limited (several tabs or a shared address) or busy: wait and try again.
    if (!backendBusy(res) || attempt >= RATE_RETRIES) break
    await new Promise((r) => setTimeout(r, retryDelay(res, attempt)))
  }
  // Still busy after the retries falls through to an 'upstream' error below:
  // the backend is up, so this is no reason to show the saved copy.
  if (gatewayDown(res)) throw new Error(`observations: ${res.status}`)
  if (res.status === 409) throw new GenerationMoved('observations: the server changed generation')
  if (!res.ok) {
    let detail = res.statusText
    try {
      const b = await res.json()
      detail = b.detail ?? b.title ?? detail
    } catch {
      /* non-JSON error body */
    }
    throw new ViewError('upstream', `observations: ${res.status} ${detail}`)
  }
  try {
    return await res.text()
  } catch (e) {
    throw new Error(`observations: ${e instanceof Error ? e.message : e}`, { cause: e }) // timed out or cut off mid-body
  }
}

/**
 * Fetches every row of a range into one staged batch. Whole past UTC days
 * come from /observations/day, which every visitor shares (HTTP caches,
 * Cloudflare, the server's Redis; D-158); the rest from /observations. The
 * first request (the part after the last whole day, or the whole range)
 * tells the window, the generation the days are asked under, and where its
 * rest begins; that rest is split into time slices fetched in parallel with
 * the days and the part before them (each paged, all into the same batch;
 * the engine drops duplicates on commit). A whole first day may hold rows
 * from before the window: views are built from the window only.
 */
async function fetchRange(params: URLSearchParams, retry = true): Promise<Fetched<number>> {
  const run = limiter(PARALLEL)
  const page = (extra: Record<string, string>) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(extra)) p.set(k, v)
    return run(() => fetchText(`/api/v1/observations?${p}`))
  }
  const iso = (ms: number) => new Date(ms).toISOString()
  const now = Date.now()
  const { lo, hi } = requestedRange(params, now)
  const days = planDays(lo, hi, now)
  type Meta = { window: Fetched<number>['window']; generation: string; more: boolean; next_cursor?: string; batch: number }
  // With whole days, the first request is the part after them (empty when the range ends there).
  const tail: Record<string, string> = days.length ? { since: iso(days[days.length - 1] + DAY_MS) } : {}
  const first = JSON.parse(engine.stage(await page(tail), 0)) as Meta
  const batch = first.batch
  // A failed request fails the range: the others stop at their next page,
  // and the batch is discarded, so no staged rows are stranded in the engine.
  let failed = false
  const stage = (text: string) => {
    if (failed) throw new ViewError('upstream', 'observations: range abandoned')
    return JSON.parse(engine.stage(text, batch)) as Meta
  }
  const drain = async (meta: Meta, extra: Record<string, string>) => {
    while (meta.more) meta = stage(await page({ ...extra, cursor: meta.next_cursor ?? '' }))
  }
  const tasks: (() => Promise<unknown>)[] = []
  if (first.more) {
    // The rest starts at the first page's cursor instant.
    const bounds = sliceBounds(cursorMs(first.next_cursor), rangeEnd(first.window.end, params.get('until')), SLICES)
    bounds.slice(0, -1).forEach((b, k) =>
      tasks.push(async () => {
        const range = { ...tail, until: iso(bounds[k + 1]) }
        if (k === 0) return drain(first, range) // continues after the first page
        if (b >= bounds[k + 1]) return
        return drain(stage(await page({ ...range, since: iso(b) })), { ...range, since: iso(b) })
      }),
    )
  }
  if (days.length) {
    // Before the first whole day: from the window's start as the server set it.
    const start = Math.max(Date.parse(first.window.start), params.has('since') ? Date.parse(params.get('since')!) : -Infinity)
    if (start < days[0]) {
      const head = { until: iso(days[0]) }
      tasks.push(async () => drain(stage(await page(head)), head))
    }
    const gen = encodeURIComponent(first.generation)
    for (const d of days) {
      tasks.push(async () => {
        const meta = stage(await run(() => fetchText(`/api/v1/observations/day/${dayName(d)}?generation=${gen}`)))
        if (meta.generation !== first.generation) throw new GenerationMoved('observations: a day of another generation')
      })
    }
  }
  const results = await Promise.allSettled(
    tasks.map(async (t) => {
      try {
        return await t()
      } catch (e) {
        failed = true
        throw e
      }
    }),
  )
  const err = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (err) {
    engine.discard(batch)
    if (err.reason instanceof GenerationMoved) {
      // Decoder, configuration or history changed between our requests:
      // start over once, under the new generation (the store then sees it).
      if (retry) return fetchRange(params, false)
      throw new ViewError('upstream', err.reason.message)
    }
    throw err.reason
  }
  return { window: first.window, generation: first.generation, batch }
}

const source: Source = {
  takeDirty: () => Array.from(engine.take_dirty()),
  exportRange: (lo, hi) => engine.export(lo, hi),
  newestT: () => engine.newest_t(),
}
const flushSoon = debounce(() => void persist?.flush(source), 2000, 5000)

const started = (async () => {
  await ready
  engine = new Engine()
  store = new RowStore(new EngineRows(), fetchRange)
  try {
    persist = await openPersistence(engineUrl)
  } catch {
    persist = null
  }
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
function synced(win: WindowReq, epoch: string): Promise<{ synced: Synced; offline: boolean }> {
  const key = JSON.stringify(win) + '|' + epoch
  if (last?.key === key) return last.result
  const result = chain.then(async () => {
    await started
    try {
      const s = await store.sync(win)
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
// and filters. A snapshot at reference density is several MB and every live
// rebuild is a new revision, so entries of older revisions are dropped and
// the total is capped.
const MEMO_MAX_BYTES = 24_000_000
const memo = new Map<string, Uint8Array>()
let memoChars = 0
function remember(key: string, revision: string, make: () => Uint8Array): Uint8Array {
  const hit = memo.get(key)
  if (hit !== undefined) return hit
  const v = make()
  for (const [k, x] of memo) {
    if (!k.startsWith(revision + '|') || memoChars + v.length > MEMO_MAX_BYTES) {
      memo.delete(k)
      memoChars -= x.length
    }
  }
  memo.set(key, v)
  memoChars += v.length
  return v
}

const NULL = [110, 117, 108, 108] // "null"
const isNull = (b: Uint8Array) => b.length === 4 && NULL.every((c, k) => b[k] === c)

async function view(req: ViewRequest): Promise<{ body: Uint8Array; meta: ViewMeta; offline: boolean }> {
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
    body = remember(key, revision, () => {
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
  if (msg.type === 'terrain') {
    try {
      await started
      await inited
      engine.set_terrain(JSON.stringify(msg.links))
      memo.clear()
      memoChars = 0
      self.postMessage({ type: 'changed' } satisfies Response)
    } catch (err) {
      if (!fatal(err)) console.warn('terrain classes dropped', err)
    }
    return
  }
  if (msg.type === 'init') {
    try {
      await started
      engine.set_options(JSON.stringify({ geo: msg.geo }))
      quantumMs = msg.liveQuantumMs
      memo.clear()
      memoChars = 0
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
