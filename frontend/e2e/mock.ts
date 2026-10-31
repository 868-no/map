import type { Page } from '@playwright/test'
import type { ObsRow } from '../src/api/types'

/**
 * Serve synthetic observations instead of the live mesh: /observations
 * returns the given rows (window and since/until applied like the API) and
 * the live stream stays silent. The browser derives everything from them.
 */
export async function mockObservations(page: Page, rows: ObsRow[], live?: Promise<() => ObsRow[]>) {
  // The stream: silent, or (when `live` resolves) one delta with those rows,
  // stamped as just observed, after a heartbeat giving the server clock.
  await page.route('**/api/v1/stream*', async (route) => {
    if (!live) return route.abort()
    const make = await live
    const now = Date.now()
    const iso = (ms: number) => new Date(ms).toISOString()
    const events = make().map((r) => ({ id: r.i, t: iso(r.t), row: r }))
    const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    return route.fulfill({
      headers: { 'content-type': 'text/event-stream' },
      body: 'retry: 600000\n\n' + sse('heartbeat', { now: iso(now), window: { start: iso(now - 72 * 3_600_000), end: iso(now), rolling: true } }) +
        sse('status', { live: true }) + sse('delta', { events }),
    })
  })
  await page.route('**/api/v1/observations*', (route) => {
    const q = new URL(route.request().url()).searchParams
    const now = Math.floor(Date.now() / 10_000) * 10_000
    const end = q.has('end') ? Date.parse(q.get('end')!) : now
    const start = q.has('start') ? Date.parse(q.get('start')!) : end - parseInt(q.get('duration') ?? '72') * 3_600_000
    const lo = Math.max(start, q.has('since') ? Date.parse(q.get('since')!) : -Infinity)
    const hi = Math.min(end, q.has('until') ? Date.parse(q.get('until')!) : Infinity)
    const iso = (ms: number) => new Date(ms).toISOString()
    return route.fulfill({
      json: {
        window: { start: iso(start), end: iso(end), rolling: !q.has('start') }, since: iso(lo), until: iso(hi), now: iso(Date.now()),
        generation: 'e2e', more: false, rows: q.has('cursor') ? [] : rows.filter((r) => r.t >= lo && r.t < hi),
      },
    })
  })
}

let seq = 0
const hex = (n: number) => n.toString(16).padStart(16, '0')

/** Rows for one node: NodeInfo (name, role) and, when given, a position; heard directly by gateway gw if given (a link). */
export function nodeRows(num: number, name: string, opts: { lat?: number; lon?: number; role?: string; gw?: number; t?: number } = {}): ObsRow[] {
  const t = opts.t ?? Date.now() - 60_000
  const rx = opts.gw === undefined ? {} : { g: opts.gw, sn: 5, rs: -90, hs: 3, hl: 3, dr: true, rr: 'zero_hop_rf' }
  const base = (y: string) => ({ i: ++seq, t, b: 'e2e', s: num, y, l: hex(seq * 7919), o: hex(seq * 104729), sg: 'unsigned', ...rx })
  const rows: ObsRow[] = [{ ...base('nodeinfo'), ni: { long_name: `${name} long`, short_name: name, role: opts.role, has_public_key: false } }]
  if (opts.lat !== undefined && opts.lon !== undefined) rows.push({ ...base('position'), po: { lat: opts.lat, lon: opts.lon, precision_bits: 32, precision_known: true } })
  return rows
}

/** A NeighborInfo report: `reporter` heard each of `neighbors` (one directed link each). */
export function neighborRow(reporter: number, neighbors: number[], t = Date.now() - 60_000): ObsRow {
  ++seq
  return { i: seq, t, b: 'e2e', s: reporter, y: 'neighborinfo', l: hex(seq * 7919), o: hex(seq * 104729), sg: 'unsigned', nb: { neighbors: neighbors.map((id) => ({ id, snr: 5 })) } }
}

/** A live reception: `gw` heard `src` directly (zero hops), just now; broadcast unless `dest` is given. */
export function directReception(src: number, gw: number, dest?: number): ObsRow {
  ++seq
  return { i: 1e9 + seq, t: Date.now(), b: 'e2e', g: gw, s: src, ...(dest === undefined ? {} : { d: dest }), y: 'text', l: hex(seq * 7919), o: hex(seq * 104729), sg: 'unsigned', sn: 6, rs: -95, hs: 3, hl: 3, dr: true, rr: 'zero_hop_rf' }
}
