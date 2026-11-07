import { describe, expect, it } from 'vitest'
import type { ObsRow } from '../src/api/types'
import { OVERLAP_MS, RowStore, type Backend, type Fetched } from '../src/derive/rowStore'

const H = 3_600_000
const T0 = Date.parse('2026-10-30T00:00:00Z')
const row = (i: number, t: number): ObsRow => ({ i, t, b: 'x', s: 1, y: 'text', l: `l${i}`, o: `o${i}`, sg: 'unsigned' })

/** The row store's backend as a plain sorted array (the worker uses the WebAssembly engine). */
class ArrayRows implements Backend<ObsRow[], ObsRow[]> {
  rows: ObsRow[] = []
  ids = new Set<number>()
  commit(batch: ObsRow[]) {
    return this.addLive(batch, -Infinity)
  }
  discard() {}
  addLive(rows: ObsRow[], lo: number) {
    const fresh = rows.filter((r) => r.t >= lo && !this.ids.has(r.i))
    for (const r of fresh) this.ids.add(r.i)
    this.rows = this.rows.concat(fresh).sort((a, b) => a.t - b.t || a.i - b.i)
    return fresh.length
  }
  reset() {
    this.rows = []
    this.ids.clear()
  }
  trimBefore(t: number) {
    for (const r of this.rows.filter((x) => x.t < t)) this.ids.delete(r.i)
    this.rows = this.rows.filter((r) => r.t >= t)
  }
  keepOnly(lo: number, hi: number) {
    const keep = this.slice(lo, hi)
    this.reset()
    this.addLive(keep, -Infinity)
  }
  newestT() {
    return this.rows.at(-1)?.t ?? 0
  }
  count() {
    return this.rows.length
  }
  slice(start: number, end: number) {
    return this.rows.filter((r) => r.t >= start && r.t < end)
  }
}

const newStore = (fetch: (p: URLSearchParams) => Promise<Fetched<ObsRow[]>>) => {
  const rows = new ArrayRows()
  const store = new RowStore(rows, fetch)
  return Object.assign(store, { held: rows })
}

/** A fake server over a fixed set of rows: applies window, since/until narrowing and paging like the API. */
function server(all: ObsRow[], now: () => number, generation = () => 'g1') {
  const calls: Record<string, string>[] = []
  const fetch = async (p: URLSearchParams): Promise<Fetched<ObsRow[]>> => {
    calls.push(Object.fromEntries(p))
    let start: number, end: number, rolling: boolean
    if (p.has('duration')) {
      end = Math.floor(now() / 10_000) * 10_000
      start = end - parseInt(p.get('duration')!) * H
      rolling = true
    } else {
      start = Date.parse(p.get('start')!)
      end = Date.parse(p.get('end')!)
      rolling = false
    }
    const lo = Math.max(start, p.has('since') ? Date.parse(p.get('since')!) : -Infinity)
    const hi = Math.min(end, p.has('until') ? Date.parse(p.get('until')!) : Infinity)
    return {
      window: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), rolling },
      generation: generation(),
      batch: all.filter((r) => r.t >= lo && r.t < hi),
    }
  }
  return { fetch, calls }
}

describe('RowStore', () => {
  it('fetches a rolling window once, then only what is new', async () => {
    const all = Array.from({ length: 100 }, (_, k) => row(k + 1, T0 + k * 60_000))
    let now = T0 + 50 * 60_000
    const s = server(all, () => now)
    const store = newStore(s.fetch)
    const a = await store.sync({ live: true, durationH: 1 })
    expect(store.held.slice(a.start, a.end).map((r) => r.i)).toEqual(Array.from({ length: 50 }, (_, k) => k + 1))
    expect(s.calls[0].since).toBeUndefined()

    now += 20 * 60_000
    const b = await store.sync({ live: true, durationH: 1 })
    expect(Date.parse(s.calls[1].since)).toBe(a.end - OVERLAP_MS)
    expect(store.held.slice(b.start, b.end).length).toBe(60) // [now-1h, now): the oldest ten aged out
    expect(store.held.slice(b.start, b.end)[0].t).toBeGreaterThanOrEqual(b.start)
    expect(new Set(store.held.rows.map((r) => r.i)).size).toBe(store.held.rows.length) // overlap deduplicated
  })

  it('keeps window isolation: rows outside [start, end) are never returned', async () => {
    const all = [row(1, T0 - 1), row(2, T0), row(3, T0 + H - 1), row(4, T0 + H)]
    const store = newStore(server(all, () => T0 + 2 * H).fetch)
    const r = await store.sync({ live: false, start: new Date(T0).toISOString(), end: new Date(T0 + H).toISOString() })
    expect(store.held.slice(r.start, r.end).map((x) => x.i)).toEqual([2, 3])
  })

  it('extends a held range in both directions for an overlapping fixed window', async () => {
    const all = Array.from({ length: 6 * 60 }, (_, k) => row(k + 1, T0 + k * 60_000))
    const s = server(all, () => T0 + 7 * H)
    const store = newStore(s.fetch)
    const iso = (h: number) => new Date(T0 + h * H).toISOString()
    await store.sync({ live: false, start: iso(2), end: iso(4) })
    const r = await store.sync({ live: false, start: iso(1), end: iso(5) })
    expect(store.held.slice(r.start, r.end).length).toBe(240)
    expect(s.calls.slice(1).map((c) => (c.since ? 'since' : c.until ? 'until' : 'full'))).toEqual(['since', 'until'])
    expect(store.cov).toEqual({ lo: T0 + H, hi: T0 + 5 * H })
  })

  it('starts over when the generation changes or the windows do not overlap', async () => {
    const all = Array.from({ length: 48 * 6 }, (_, k) => row(k + 1, T0 + k * 600_000))
    let gen = 'g1'
    const s = server(all, () => T0 + 49 * H, () => gen)
    const store = newStore(s.fetch)
    const iso = (h: number) => new Date(T0 + h * H).toISOString()
    await store.sync({ live: false, start: iso(0), end: iso(2) })
    await store.sync({ live: false, start: iso(10), end: iso(12) })
    expect(store.held.rows.every((r) => r.t >= T0 + 10 * H)).toBe(true)
    gen = 'g2'
    await store.sync({ live: false, start: iso(11), end: iso(13) })
    expect(store.generation).toBe('g2')
    expect(store.cov).toEqual({ lo: T0 + 11 * H, hi: T0 + 13 * H })
  })

  it('releases what a window that does not contain the last one cannot use, in fresh memory', async () => {
    const all = Array.from({ length: 96 * 6 }, (_, k) => row(k + 1, T0 + k * 600_000)) // four days, every 10 min
    let now = T0 + 96 * H
    const s = server(all, () => now)
    const store = newStore(s.fetch)
    const kept: [number, number][] = []
    const keepOnly = store.held.keepOnly.bind(store.held)
    store.held.keepOnly = (lo, hi) => {
      kept.push([lo, hi])
      keepOnly(lo, hi)
    }
    await store.sync({ live: true, durationH: 72 }, now)
    // The rolling window moving on, and growing, contains the last one: nothing released.
    now += H
    await store.sync({ live: true, durationH: 72 }, now)
    await store.sync({ live: true, durationH: 96 }, now)
    expect(kept).toEqual([])
    // Shorter: only the last day (and a minute's margin) stays.
    await store.sync({ live: true, durationH: 24 }, now)
    expect(kept).toHaveLength(1)
    expect(store.held.rows.every((r) => r.t >= now - 24 * H - 60_000)).toBe(true)
    // A fixed window inside the held range but not containing the last window: its part only.
    const iso = (t: number) => new Date(t).toISOString()
    await store.sync({ live: false, start: iso(now - 20 * H), end: iso(now - 10 * H) }, now)
    expect(kept).toHaveLength(2)
    expect(store.held.rows.every((r) => r.t >= now - 20 * H && r.t < now - 10 * H)).toBe(true)
    expect(store.cov).toEqual({ lo: now - 20 * H, hi: now - 10 * H })
    // Back to a rolling window that contains it: nothing released; the newer rows are fetched.
    const r = await store.sync({ live: true, durationH: 24 }, now)
    expect(kept).toHaveLength(2)
    expect(store.held.slice(r.start, r.end).map((x) => x.i)).toEqual(all.filter((x) => x.t >= r.start && x.t < r.end).map((x) => x.i))
  })

  it('offline with nothing held, takes what the cache has of the window', async () => {
    const all = Array.from({ length: 60 }, (_, k) => row(k + 1, T0 + k * 60_000))
    const fail = async (): Promise<Fetched<ObsRow[]>> => {
      throw new Error('offline')
    }
    const covered = { lo: T0, hi: T0 + 30 * 60_000 }
    const rows = new ArrayRows()
    const store = new RowStore(rows, fail, async () => ({ window: { start: '', end: '', rolling: true }, generation: 'g1', batch: all.slice(0, 30), covered }))
    await expect(store.sync({ live: true, durationH: 1 }, T0 + H)).rejects.toThrow('offline')
    expect(await store.fromCache({ live: true, durationH: 1 })).toBe(true)
    expect(store.cov).toEqual(covered)
    expect(store.generation).toBe('g1')
    const r = store.offline({ live: true, durationH: 1 }, T0 + H)!
    expect(rows.slice(r.start, r.end).length).toBe(30)
    expect(await new RowStore(new ArrayRows(), fail).fromCache({ live: true, durationH: 1 })).toBe(false) // no cache
  })

  it('offline with a shorter window held, adds what the cache has before it', async () => {
    const all = Array.from({ length: 120 }, (_, k) => row(k + 1, T0 + k * 60_000))
    const now = T0 + 2 * H
    const s = server(all, () => now)
    let online = true
    const rows = new ArrayRows()
    const store = new RowStore(rows, (p) => (online ? s.fetch(p) : Promise.reject(new Error('offline'))), async () => ({
      window: { start: '', end: '', rolling: true }, generation: 'g1', batch: all, covered: { lo: T0, hi: now },
    }))
    await store.sync({ live: true, durationH: 1 }, now)
    online = false
    await expect(store.sync({ live: true, durationH: 2 }, now)).rejects.toThrow('offline')
    expect(await store.fromCache({ live: true, durationH: 2 }, now)).toBe(true)
    expect(store.cov).toEqual({ lo: T0, hi: now })
    expect(rows.count()).toBe(120)
  })

  it('serves held rows offline, clipped to the window', async () => {
    const all = Array.from({ length: 60 }, (_, k) => row(k + 1, T0 + k * 60_000))
    const store = newStore(server(all, () => T0 + H).fetch)
    await store.sync({ live: true, durationH: 1 })
    const r = store.offline({ live: true, durationH: 1 }, T0 + H + 30 * 60_000)!
    expect(store.held.slice(r.start, r.end).every((x) => x.t >= r.start && x.t < r.end)).toBe(true)
    expect(store.held.slice(r.start, r.end).length).toBe(30)
    expect(newStore(server([], () => 0).fetch).offline({ live: true, durationH: 1 })).toBeNull()
  })
})

describe('RowStore live rows', () => {
  it('merges streamed rows without moving coverage, and ignores rows before it', async () => {
    const all = Array.from({ length: 10 }, (_, k) => row(k + 1, T0 + k * 60_000))
    const store = newStore(server(all, () => T0 + H).fetch)
    expect(store.addLive([row(99, T0)])).toBe(false) // nothing held yet
    await store.sync({ live: true, durationH: 1 })
    const cov = { ...store.cov! }
    expect(store.addLive([row(11, T0 + H + 5_000), row(5, T0 + 4 * 60_000)])).toBe(true)
    expect(store.addLive([row(11, T0 + H + 5_000)])).toBe(false) // duplicate
    expect(store.addLive([row(12, cov.lo - 1)])).toBe(false) // before coverage
    expect(store.cov).toEqual(cov)
    expect(store.held.slice(T0, T0 + 2 * H).map((r) => r.i).at(-1)).toBe(11)
  })
})
