// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DELTA_OVERLAP_MS, gunzip, gzip, HOUR_MS, HourWriter, MAX_DELTAS, type Source, type Write } from '../src/derive/persist'

const T0 = Date.parse('2026-10-30T10:00:00Z')
type Row = { i: number; t: number }

/** The engine as persistence sees it: sorted rows, dirty hours, exports. */
class Rows implements Source {
  rows: Row[] = []
  dirty = new Set<number>()
  exported = 0 // rows exported so far (the per-flush cost)
  add(...rs: Row[]) {
    for (const r of rs) {
      if (this.rows.some((x) => x.i === r.i)) continue
      this.rows.push(r)
      this.dirty.add(Math.floor(r.t / HOUR_MS) * HOUR_MS)
    }
    this.rows.sort((a, b) => a.t - b.t || a.i - b.i)
  }
  takeDirty() {
    const d = [...this.dirty]
    this.dirty.clear()
    return d
  }
  exportRange(lo: number, hi: number) {
    const s = this.rows.filter((r) => r.t >= lo && r.t < hi)
    this.exported += s.length
    return JSON.stringify(s)
  }
  newestT() {
    return this.rows.at(-1)?.t ?? 0
  }
}

/** The stores as IndexedDB holds them, with the same write semantics as openPersistence. */
class Stored {
  chunks = new Map<number, string>()
  deltas = new Map<string, string>() // "hour:seq"
  apply(ws: Write[], before?: number) {
    if (before !== undefined) {
      for (const h of this.chunks.keys()) if (h < before) this.chunks.delete(h)
      for (const k of this.deltas.keys()) if (Number(k.split(':')[0]) < before) this.deltas.delete(k)
    }
    for (const w of ws) {
      if (!w.full) {
        if (w.text !== '[]') this.deltas.set(`${w.hour}:${w.seq}`, w.text)
        continue
      }
      for (const k of this.deltas.keys()) if (k.startsWith(`${w.hour}:`)) this.deltas.delete(k)
      if (w.text === '[]') this.chunks.delete(w.hour)
      else this.chunks.set(w.hour, w.text)
    }
  }
  /** What a load restores: every row once, plus the hours and their highest delta seq. */
  load(): { rows: Row[]; hours: Map<number, number> } {
    const byId = new Map<number, Row>()
    for (const text of [...this.chunks.values(), ...this.deltas.values()]) for (const r of JSON.parse(text) as Row[]) byId.set(r.i, r)
    const hours = new Map<number, number>()
    for (const h of this.chunks.keys()) hours.set(h, 0)
    for (const k of this.deltas.keys()) {
      const [h, s] = k.split(':').map(Number)
      hours.set(h, Math.max(hours.get(h) ?? 0, s))
    }
    return { rows: [...byId.values()].sort((a, b) => a.t - b.t || a.i - b.i), hours }
  }
}

const ids = (rs: Row[]) => rs.map((r) => r.i)
const flush = (w: HourWriter, src: Rows, db: Stored) => {
  const ws = w.plan(src.takeDirty(), src)
  db.apply(ws)
  return ws
}

describe('persistence writes', () => {
  it('round-trips rows through full chunks', () => {
    const src = new Rows(), db = new Stored(), w = new HourWriter()
    src.add({ i: 1, t: T0 + 5 }, { i: 2, t: T0 + HOUR_MS + 5 }, { i: 3, t: T0 + 2 * HOUR_MS + 5 })
    const ws = flush(w, src, db)
    expect(ws.every((x) => x.full)).toBe(true)
    expect(ids(db.load().rows)).toEqual([1, 2, 3])
  })

  it('appends only recent rows of the open hour', () => {
    const src = new Rows(), db = new Stored(), w = new HourWriter()
    for (let k = 0; k < 300; k++) src.add({ i: k, t: T0 + k * 10_000 }) // 50 min of rows
    flush(w, src, db)
    src.exported = 0
    src.add({ i: 1000, t: T0 + 3_000_000 + 1 })
    const ws = flush(w, src, db)
    expect(ws).toHaveLength(1)
    expect(ws[0]).toMatchObject({ hour: T0, full: false, seq: 1 })
    // Only the overlap and the new row were exported, not the hour's 300 rows.
    expect(src.exported).toBeLessThanOrEqual(DELTA_OVERLAP_MS / 10_000 + 2)
    expect(ids(db.load().rows)).toEqual(ids(src.rows))
  })

  it('compacts the hour into one chunk when the next hour starts, keeping late rows', () => {
    const src = new Rows(), db = new Stored(), w = new HourWriter()
    src.add({ i: 1, t: T0 + 40 * 60_000 })
    flush(w, src, db)
    src.add({ i: 2, t: T0 + 50 * 60_000 })
    flush(w, src, db)
    src.add({ i: 3, t: T0 + 5 * 60_000 }) // merged late, older than the overlap: missed by the delta
    flush(w, src, db)
    expect(db.deltas.size).toBe(2)
    expect(ids(db.load().rows)).toEqual([1, 2])
    src.add({ i: 4, t: T0 + HOUR_MS + 1000 }) // rollover
    const ws = flush(w, src, db)
    expect(ws.map((x) => [x.hour, x.full])).toEqual([[T0, true], [T0 + HOUR_MS, true]])
    expect(db.deltas.size).toBe(0)
    expect(ids(db.load().rows)).toEqual([3, 1, 2, 4]) // by time
  })

  it('rewrites an hour in full after MAX_DELTAS deltas', () => {
    const src = new Rows(), db = new Stored(), w = new HourWriter()
    src.add({ i: 0, t: T0 })
    flush(w, src, db)
    for (let k = 1; k <= MAX_DELTAS + 1; k++) {
      src.add({ i: k, t: T0 + k * 1000 })
      flush(w, src, db)
    }
    expect(db.deltas.size).toBe(0)
    expect(db.chunks.size).toBe(1)
    expect(ids(db.load().rows)).toEqual(ids(src.rows))
  })

  it('continues deltas after a reload and compacts leftovers of closed hours', () => {
    const src = new Rows(), db = new Stored(), w = new HourWriter()
    src.add({ i: 1, t: T0 + 1000 })
    flush(w, src, db)
    src.add({ i: 2, t: T0 + 2000 })
    flush(w, src, db) // delta seq 1 for hour T0
    // Reload: the engine gets what was stored, then one more hour of rows arrives.
    const { rows, hours } = db.load()
    const src2 = new Rows(), w2 = new HourWriter()
    src2.add(...rows)
    src2.takeDirty()
    w2.restore(hours, src2)
    db.apply(w2.plan([], src2)) // the open hour keeps its delta
    expect(db.deltas.size).toBe(1)
    src2.add({ i: 3, t: T0 + 3000 })
    expect(flush(w2, src2, db)[0]).toMatchObject({ full: false, seq: 2 }) // no key clash
    src2.add({ i: 4, t: T0 + HOUR_MS })
    flush(w2, src2, db)
    expect(db.deltas.size).toBe(0)
    expect(ids(db.load().rows)).toEqual([1, 2, 3, 4])
  })

  it('drops trimmed hours and rewrites the partly trimmed one', () => {
    const src = new Rows(), db = new Stored(), w = new HourWriter()
    src.add({ i: 1, t: T0 + 1000 }, { i: 2, t: T0 + HOUR_MS + 1000 }, { i: 3, t: T0 + HOUR_MS + 2000 })
    flush(w, src, db)
    const cut = T0 + HOUR_MS + 1500
    src.rows = src.rows.filter((r) => r.t >= cut)
    db.apply(w.removedBefore(cut, src), Math.floor(cut / HOUR_MS) * HOUR_MS)
    expect(ids(db.load().rows)).toEqual([3])
  })

  it('compresses losslessly', async () => {
    const text = JSON.stringify([{ i: 1, t: T0, n: 'Ærlig Øst Ål 📡' }])
    expect(await gunzip(await gzip(text))).toBe(text)
  })
})
