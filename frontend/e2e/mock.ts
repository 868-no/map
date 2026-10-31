import type { Page } from '@playwright/test'
import type { ObsRow } from '../src/api/types'

/**
 * Serve synthetic observations instead of the live mesh: /observations
 * returns the given rows (window and since/until applied like the API) and
 * the live stream stays silent. The browser derives everything from them.
 */
export async function mockObservations(page: Page, rows: ObsRow[]) {
  await page.route('**/api/v1/stream*', (route) => route.abort())
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
