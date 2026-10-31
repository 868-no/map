// @vitest-environment node
// Client-side derivation must match the server's views for the same window.
// Runs only against a live stack: PARITY_BASE=http://localhost:8080 npm test
import { describe, expect, it } from 'vitest'
import type { ObsRow, ObservationsBody } from '../src/api/types'
import { applyFilters, bucketFor, buildNodeDetail, buildSnapshot, buildTraffic, type GeoOptions } from '../src/derive/views'

const BASE = process.env.PARITY_BASE

async function json<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path)
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
  return r.json() as Promise<T>
}

/** Times to whole milliseconds (the server keeps microseconds), floats to 1e-4, metadata dropped. */
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (k !== 'meta' && k !== '$schema') out[k] = normalize(x)
    return out
  }
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v)) return Math.floor(Date.parse(v.replace(/(\.\d{3})\d+/, '$1')))
  if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 1e4) / 1e4
  return v
}

const byNode = (a: { node: string }, b: { node: string }) => (a.node < b.node ? -1 : 1)

describe.skipIf(!BASE)('client derivation matches the server', () => {
  it('snapshot, traffic and node details', async () => {
    const ret = await json<{ earliest_observation?: string; latest_observation?: string }>('/api/v1/retention')
    const caps = await json<{ geolocation: { enabled: boolean; min_precision_bits: number; exclude: string[] } }>('/api/v1/capabilities')
    const end = new Date(Math.floor(Date.parse(ret.latest_observation!) / 60_000) * 60_000) // a closed, past window
    const start = new Date(Math.max(Date.parse(ret.earliest_observation!) - 60_000, end.getTime() - 72 * 3_600_000))
    if (end.getTime() - start.getTime() < 3_600_000) start.setTime(end.getTime() - 3_600_000)
    const win = `start=${start.toISOString()}&end=${end.toISOString()}`

    let rows: ObsRow[] = []
    for (let after = 0; ; ) {
      const b = await json<ObservationsBody>(`/api/v1/observations?${win}&after=${after}`)
      rows = rows.concat(b.rows ?? [])
      if (!b.more) break
      after = b.next_after
    }
    rows.sort((a, b) => a.t - b.t || a.i - b.i)
    expect(rows.length).toBeGreaterThan(0)
    const geo: GeoOptions = {
      enabled: caps.geolocation.enabled, minPrecisionBits: caps.geolocation.min_precision_bits,
      exclude: new Set(caps.geolocation.exclude.map((id) => parseInt(id.slice(1), 16))),
      params: { minAnchors: 3, minSamples: 5, minAnchorSpacingM: 200, minSpreadM: 500, minShapeRatio: 0.2, maxAnchorDistanceM: 150_000, floorM: 500, uncalibratedFloorM: 2000 },
    }

    const server = await json<Record<string, unknown>>(`/api/v1/snapshot?${win}`)
    const client = buildSnapshot(rows, geo)
    expect(normalize(client)).toEqual(normalize(server))

    const traffic = await json<Record<string, unknown>>(`/api/v1/traffic?${win}`)
    expect(normalize(buildTraffic(rows, start.getTime(), bucketFor(end.getTime() - start.getTime())))).toEqual(normalize(traffic))

    // A filtered snapshot too.
    const filtered = await json<Record<string, unknown>>(`/api/v1/snapshot?${win}&type=position,nodeinfo`)
    expect(normalize(buildSnapshot(applyFilters(rows, { types: ['position', 'nodeinfo'] }), geo))).toEqual(normalize(filtered))

    const nodes = client.nodes ?? []
    const ids = nodes.slice(0, 15).map((n) => n.id).concat(nodes.filter((n) => n.status === 'referenced').slice(0, 3).map((n) => n.id))
    for (const id of ids) {
      const s = await json<{ heard_by: { node: string }[]; heard: { node: string }[] }>(`/api/v1/nodes/${encodeURIComponent(id)}?${win}`)
      const c = buildNodeDetail(rows, parseInt(id.slice(1), 16))!
      s.heard_by?.sort(byNode)
      s.heard?.sort(byNode)
      c.heard_by?.sort(byNode)
      c.heard?.sort(byNode)
      expect(normalize(c), id).toEqual(normalize(s))
    }
  }, 60_000)
})
