/// <reference lib="webworker" />
// Derivation worker: holds the browser's copy of the packet log in the
// WebAssembly engine and builds every view from it, off the main thread
// (D-031, D-040). Rows travel as JSON text straight into the engine; views
// come back as JSON text and are handed to the page as transferable bytes.
import init, { Engine } from '../engine/pkg/engine.js'
import { openPersistence, HOUR_MS, type Persistence } from './persist'
import { RowStore, type Backend, type Fetched, type Synced, type WindowReq } from './rowStore'
import { debounce } from './debounce'
import type { Request, Response, Transmission, ViewRequest } from './protocol'

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const ready = init()
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

/**
 * Fetches every row of a range into one staged batch. The first page tells
 * the window and where the rest begins; the rest is split into time slices
 * fetched in parallel (each paged, all into the same batch; the engine drops
 * duplicates on commit).
 */
async function fetchRange(params: URLSearchParams): Promise<Fetched<number>> {
  const page = async (extra: Record<string, string>) => {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(extra)) p.set(k, v)
    const res = await fetch(`/api/v1/observations?${p}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      let detail = res.statusText
      try {
        const b = await res.json()
        detail = b.detail ?? b.title ?? detail
      } catch {
        /* non-JSON error body */
      }
      throw new HttpError(res.status, detail)
    }
    return res.text()
  }
  type Meta = { window: Fetched<number>['window']; generation: string; more: boolean; next_cursor?: string; batch: number }
  const first = JSON.parse(engine.stage(await page({}), 0)) as Meta
  const batch = first.batch
  const drain = async (meta: Meta, extra: Record<string, string>) => {
    while (meta.more) meta = JSON.parse(engine.stage(await page({ ...extra, cursor: meta.next_cursor ?? '' }), batch)) as Meta
  }
  if (first.more) {
    // The cursor is "<unix µs>.<id>": the rest starts at that instant.
    const lo = Math.floor(Number((first.next_cursor ?? '0').split('.')[0]) / 1000)
    const until = params.get('until')
    const hi = Math.min(Date.parse(first.window.end), until ? Date.parse(until) : Infinity)
    const step = Math.max(Math.ceil((hi - lo) / SLICES), 1)
    const bounds = Array.from({ length: SLICES + 1 }, (_, k) => Math.min(lo + k * step, hi))
    const iso = (ms: number) => new Date(ms).toISOString()
    await Promise.all(
      bounds.slice(0, -1).map(async (b, k) => {
        const range = { until: iso(bounds[k + 1]) }
        if (k === 0) return drain(first, range) // continues after the first page
        if (b >= bounds[k + 1]) return
        const m = JSON.parse(engine.stage(await page({ since: iso(b), ...range }), batch)) as Meta
        return drain(m, { since: iso(b), ...range })
      }),
    )
  }
  return { window: first.window, generation: first.generation, batch }
}

const source = { takeDirty: () => Array.from(engine.take_dirty()), exportHour: (h: number) => engine.export(h, h + HOUR_MS) }
const flushSoon = debounce(() => void persist?.flush(source), 2000, 5000)

const started = (async () => {
  await ready
  engine = new Engine()
  store = new RowStore(new EngineRows(), fetchRange)
  try {
    persist = await openPersistence()
  } catch {
    persist = null
  }
  if (persist) {
    for (const chunk of persist.restored.chunks) engine.add_rows(chunk, -Infinity)
    engine.take_dirty() // restored rows are already stored
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
      if (e instanceof HttpError) throw e
      const s = store.offline(win, Date.now(), quantumMs)
      if (!s) throw new HttpError(503, 'offline and no saved data for this window')
      return { synced: s, offline: true }
    }
  })
  chain = result.catch(() => {})
  last = { key, result }
  result.catch(() => {
    if (last?.key === key) last = null // retry next time
  })
  return result
}

/**
 * The window to build. A rolling one ends just after the newest row held (or
 * at the last sync, which runs at least once a minute): it follows the data,
 * so every view requested for one rebuild gets the same window and shares one
 * memoised snapshot, and a streamed row counts as soon as it is merged.
 */
function bounds(win: WindowReq, s: Synced, offline: boolean): { start: number; end: number } {
  if (!win.live || offline) return { start: s.start, end: s.end }
  const end = Math.max(s.end, engine.newest_t() + 1)
  return { start: end - win.durationH * 3_600_000, end }
}

// Rebuild notices are debounced: views rebuild once the stream pauses for
// 2 s, and at least every 5 s while it keeps flowing. Pings do not wait.
export const REBUILD_QUIET_MS = 2000
export const REBUILD_MAX_MS = 5000
const changed = debounce(() => self.postMessage({ type: 'changed' } satisfies Response), REBUILD_QUIET_MS, REBUILD_MAX_MS)

/** Live rows from the stream: merged, plus ping attribution for those the page wants animated. */
function liveRows(rows: unknown[], ping: number[]) {
  if (!engine) return
  const text = JSON.stringify(rows)
  if (ping.length) {
    const tx = JSON.parse(engine.transmissions(JSON.stringify(ping.map((k) => rows[k])))) as Transmission[][]
    self.postMessage({ type: 'pings', transmissions: tx.flat() } satisfies Response)
  }
  if (!store.cov) {
    pendingLive.push(text)
    return
  }
  if (store.addLive(text)) changed()
}

// Views are memoised (as JSON text) by data revision, kind, window and filters.
const memo = new Map<string, string>()
function remember(key: string, make: () => string): string {
  const hit = memo.get(key)
  if (hit !== undefined) return hit
  const v = make()
  memo.set(key, v)
  if (memo.size > 24) memo.delete(memo.keys().next().value!)
  return v
}

async function view(req: ViewRequest): Promise<{ body: string; offline: boolean }> {
  await inited
  const { synced: sy, offline } = await synced(req.win, req.epoch)
  const { start, end } = bounds(req.win, sy, offline)
  const f = { channels: req.filters.channels, brokers: req.filters.brokers, types: req.filters.types }
  const fj = JSON.stringify(f)
  const revision = `${store.generation}.${engine.revision(start, end)}`
  const meta = JSON.stringify({
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), rolling: sy.rolling },
    revision,
    filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v.length)),
    generated_at: new Date().toISOString(),
  })
  const key = `${revision}|${start}|${end}|${fj}|${req.kind}|${req.node ?? ''}`
  let body: string
  try {
    body = remember(key, () => engine.view(req.kind, start, end, fj, req.node ?? ''))
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e))
  }
  if (body === 'null') throw new HttpError(404, 'node not observed or referenced in the selected window')
  // Splice the meta in without parsing the (possibly large) body here.
  return { body: body === '{}' ? `{"meta":${meta}}` : `{"meta":${meta},${body.slice(1)}`, offline }
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const msg = e.data
  if (msg.type === 'rows') {
    await started
    liveRows(msg.rows, msg.ping)
    return
  }
  if (msg.type === 'init') {
    await started
    engine.set_options(JSON.stringify({ geo: msg.geo }))
    quantumMs = msg.liveQuantumMs
    memo.clear()
    initDone()
    return
  }
  let out: Response
  const transfer: Transferable[] = []
  try {
    const { body, offline } = await view(msg)
    const bytes = new TextEncoder().encode(body)
    transfer.push(bytes.buffer)
    out = { id: msg.id, ok: true, body: bytes, offline }
  } catch (err) {
    out = { id: msg.id, ok: false, status: err instanceof HttpError ? err.status : 500, message: err instanceof Error ? err.message : String(err) }
  }
  self.postMessage(out, transfer)
}
