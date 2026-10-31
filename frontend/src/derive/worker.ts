/// <reference lib="webworker" />
// Derivation worker: holds the browser's copy of the packet log and builds
// every view from it off the main thread (D-031).
import type { ObsRow, ObservationsBody } from '../api/types'
import { openPersistence } from './persist'
import { RowStore, type Fetched, type Synced, type WindowReq } from './rowStore'
import { bucketFor, buildNodeDetail, buildSnapshot, buildTraffic, applyFilters, type GeoOptions } from './views'
import { defaultGeoParams } from './geo'
import { debounce } from './debounce'
import { buildPacketLog, contextFromSnapshot } from './packetlog'
import { buildRoute } from './route'
import type { Request, Response, ViewRequest } from './protocol'

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function fetchRange(params: URLSearchParams): Promise<Fetched> {
  let cursor = ''
  let out: Fetched | null = null
  for (;;) {
    if (cursor) params.set('cursor', cursor)
    const res = await fetch(`/api/v1/observations?${params}`, { headers: { Accept: 'application/json' } })
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
    const b = (await res.json()) as ObservationsBody
    if (!out) out = { window: b.window, generation: b.generation, rows: [] }
    out.rows = out.rows.concat(b.rows ?? [])
    if (!b.more) return out
    cursor = b.next_cursor ?? ''
  }
}

let geo: GeoOptions = { enabled: false, minPrecisionBits: 15, exclude: new Set(), params: defaultGeoParams }
let quantumMs = 10_000
// Views wait for the operator's geolocation settings from the page.
let initDone: () => void
const inited = new Promise<void>((resolve) => (initDone = resolve))
const store = new RowStore(fetchRange)
const ready = openPersistence()
  .then((p) => {
    if (!p) return
    store.load(p.restored.rows, p.restored.cov, p.restored.generation)
    store.sink = p.sink
  })
  .catch(() => {})

// One sync at a time; repeated requests for the same window and epoch share
// it. Between syncs the store grows from the live stream.
let chain: Promise<unknown> = Promise.resolve()
let last: { key: string; result: Promise<{ synced: Synced; offline: boolean }> } | null = null
let pendingLive: ObsRow[] = [] // streamed before the first sync established coverage
function synced(win: WindowReq, epoch: string): Promise<{ synced: Synced; offline: boolean }> {
  const key = JSON.stringify(win) + '|' + epoch
  if (last?.key === key) return last.result
  const result = chain.then(async () => {
    await ready
    try {
      const s = await store.sync(win)
      if (pendingLive.length) {
        store.addLive(pendingLive)
        pendingLive = []
      }
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
  const end = Math.max(s.end, store.newestT() + 1)
  return { start: end - win.durationH * 3_600_000, end }
}

// Rebuild notices are debounced: views rebuild once the stream pauses for
// 2 s, and at least every 5 s while it keeps flowing. Pings do not wait.
export const REBUILD_QUIET_MS = 2000
export const REBUILD_MAX_MS = 5000
const changed = debounce(() => self.postMessage({ type: 'changed' } satisfies Response), REBUILD_QUIET_MS, REBUILD_MAX_MS)
function liveRows(rows: ObsRow[]) {
  if (!store.cov) {
    pendingLive = pendingLive.concat(rows)
    return
  }
  if (store.addLive(rows)) changed()
}

// Derived views are memoised by data revision, kind and filters.
const memo = new Map<string, unknown>()
function remember(key: string, make: () => unknown): unknown {
  if (memo.has(key)) return memo.get(key)
  const v = make()
  memo.set(key, v)
  if (memo.size > 24) memo.delete(memo.keys().next().value!)
  return v
}

function parseNode(id: string): number | null {
  const m = /^!([0-9a-f]{8})$/i.exec(id)
  if (m) return parseInt(m[1], 16)
  return /^\d+$/.test(id) ? Number(id) : null
}

async function view(req: ViewRequest): Promise<{ body: unknown; offline: boolean }> {
  await inited
  const { synced: sy, offline } = await synced(req.win, req.epoch)
  const { start, end } = bounds(req.win, sy, offline)
  const s = { start, end, rows: store.slice(start, end) }
  const f = { channels: req.filters.channels, brokers: req.filters.brokers, types: req.filters.types }
  const maxId = s.rows.reduce((m, r) => Math.max(m, r.i), 0)
  const revision = `${store.generation}.n${s.rows.length}.m${maxId}`
  const meta = {
    window: { start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), rolling: sy.rolling },
    revision,
    filters: Object.fromEntries(Object.entries(f).filter(([, v]) => v.length)),
    generated_at: new Date().toISOString(),
  }
  const keyOf = (kind: string, node = '') => `${revision}|${s.start}|${s.end}|${JSON.stringify(f)}|${kind}|${node}`
  const key = keyOf(req.kind, req.node)
  const rows = () => applyFilters(s.rows, f)
  let body: unknown
  switch (req.kind) {
    case 'snapshot':
      body = remember(key, () => buildSnapshot(rows(), geo))
      break
    case 'traffic':
      body = remember(key, () => buildTraffic(rows(), s.start, bucketFor(s.end - s.start)))
      break
    case 'packetlog': {
      const num = parseNode(req.node ?? '')
      if (num == null) throw new HttpError(400, 'invalid node id')
      // Relay bytes resolve against the same context the snapshot used.
      const snap = remember(keyOf('snapshot'), () => buildSnapshot(rows(), geo)) as ReturnType<typeof buildSnapshot>
      body = remember(key, () => buildPacketLog(rows(), num, contextFromSnapshot(snap.nodes ?? [], snap.edges ?? [])))
      break
    }
    case 'route': {
      const lp = req.node ?? ''
      const snap = remember(keyOf('snapshot'), () => buildSnapshot(rows(), geo)) as ReturnType<typeof buildSnapshot>
      body = remember(key, () => buildRoute(rows().filter((r) => r.l === lp), contextFromSnapshot(snap.nodes ?? [], snap.edges ?? []), snap.nodes ?? []) ?? { origin: '', type: '', segments: [], receptions: 0 })
      break
    }
    case 'node': {
      const num = parseNode(req.node ?? '')
      if (num == null) throw new HttpError(400, 'invalid node id')
      const d = remember(key, () => buildNodeDetail(rows(), num))
      if (!d) throw new HttpError(404, 'node not observed or referenced in the selected window')
      body = d
      break
    }
  }
  return { body: { meta, ...(body as object) }, offline }
}

self.onmessage = async (e: MessageEvent<Request>) => {
  const msg = e.data
  if (msg.type === 'rows') {
    liveRows(msg.rows)
    return
  }
  if (msg.type === 'init') {
    const g = msg.geo
    geo = {
      enabled: g.enabled, minPrecisionBits: g.min_precision_bits,
      exclude: new Set((g.exclude ?? []).flatMap((id) => (parseNode(id) != null ? [parseNode(id)!] : []))),
      params: {
        minAnchors: g.min_anchors, minSamples: g.min_samples, minAnchorSpacingM: g.min_anchor_spacing_m, minSpreadM: g.min_spread_m,
        minShapeRatio: g.min_shape_ratio, maxAnchorDistanceM: g.max_anchor_distance_m, floorM: g.floor_m, uncalibratedFloorM: g.uncalibrated_floor_m,
        ...(g.calibration ? { calibration: g.calibration } : {}),
      },
    }
    quantumMs = msg.liveQuantumMs
    memo.clear()
    initDone()
    return
  }
  let out: Response
  try {
    const { body, offline } = await view(msg)
    out = { id: msg.id, ok: true, body, offline }
  } catch (err) {
    out = { id: msg.id, ok: false, status: err instanceof HttpError ? err.status : 500, message: err instanceof Error ? err.message : String(err) }
  }
  self.postMessage(out)
}
