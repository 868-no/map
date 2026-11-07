// @vitest-environment node
// The read-through cache (D-184) against a minimal in-memory IndexedDB
// stand-in: only what it uses, with transactions completing (or aborting) on
// a later tick, and a failed put aborting the whole transaction.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_DAYS, MAX_PIECES, mergePages, OPEN_TIMEOUT_MS, openCache, UNUSED_MS, type IdleCache } from '../src/derive/cache'
import { DAY_MS } from '../src/derive/slices'
import { gzip } from '../src/derive/compress'

type Handler = ((e?: unknown) => void) | null

class FakeRequest {
  result: unknown
  error: unknown = null
  onsuccess: Handler = null
  onerror: Handler = null
  onblocked: Handler = null
  onupgradeneeded: Handler = null
  transaction = null
}

class FakeDB {
  stores = new Map<string, Map<string, unknown>>([['days', new Map()], ['recent', new Map()], ['meta', new Map()]])
  failPuts = false // puts of texts fail, as when the quota is exceeded
  closed = false
  onversionchange: Handler = null
  objectStoreNames = { contains: (n: string) => this.stores.has(n) }
  /** Called as a transaction begins: lets a test write as another tab would, in between. */
  beforeTransaction: ((scope: string[], mode: string) => void) | null = null
  close() {
    this.closed = true
  }
  /**
   * Like IndexedDB: requests apply in order and later ones see earlier ones;
   * the transaction completes once no request is pending, and a failure rolls
   * all of it back.
   */
  transaction(names: string | string[], mode = 'readonly') {
    if (this.closed) throw new Error('InvalidStateError: the database is closed')
    const scope = ([] as string[]).concat(names)
    this.beforeTransaction?.(scope, mode)
    const stores = this.stores, failPuts = this.failPuts
    const snapshot = new Map(scope.map((n) => [n, new Map(stores.get(n)!)]))
    let pending = 0, finished = false, failed = false
    const tx = {
      error: null as unknown,
      oncomplete: null as Handler,
      onerror: null as Handler,
      onabort: null as Handler,
      objectStore(name: string) {
        if (!scope.includes(name)) throw new Error(`${name} not in this transaction`)
        const s = stores.get(name)!
        const req = (v: () => unknown) => {
          const r = new FakeRequest()
          pending++
          const value = v() // read now: later requests of this transaction come after it
          setTimeout(() => {
            r.result = value
            pending--
            r.onsuccess?.()
            idle()
          }, 0)
          return r
        }
        const sorted = () => [...s.entries()].sort((x, y) => Number(JSON.parse(x[0])) - Number(JSON.parse(y[0])))
        return {
          getAllKeys: () => req(() => sorted().map(([k]) => JSON.parse(k))),
          getAll: () => req(() => sorted().map(([, v]) => v)),
          get: (k: unknown) => req(() => s.get(JSON.stringify(k))),
          put: (v: unknown, k: unknown) => {
            if (failPuts && name !== 'meta') failed = true
            s.set(JSON.stringify(k), v)
          },
          delete: (k: unknown) => void s.delete(JSON.stringify(k)),
          clear: () => s.clear(),
        }
      },
    }
    const idle = () =>
      setTimeout(() => {
        if (pending || finished) return
        finished = true
        if (failed) {
          for (const [n, m] of snapshot) stores.set(n, m)
          tx.error = new DOMException('quota', 'QuotaExceededError')
          tx.onabort?.()
        } else tx.oncomplete?.()
      }, 0)
    idle()
    return tx
  }
}

/** Installs the stand-in; `answer` decides what the open request does. */
function install(answer: (req: FakeRequest, db: FakeDB) => void, db = new FakeDB()): FakeDB {
  vi.stubGlobal('indexedDB', {
    open: () => {
      const req = new FakeRequest()
      setTimeout(() => answer(req, db), 0)
      return req
    },
    deleteDatabase: () => new FakeRequest(),
  })
  return db
}
const succeed = (req: FakeRequest, db: FakeDB) => {
  req.result = db
  req.onsuccess?.()
}

const D0 = Date.parse('2026-10-20T00:00:00Z')
const page = (gen: string, ids: number[], t0 = D0) => JSON.stringify({ window: { start: 'a', end: 'b' }, generation: gen, rows: ids.map((i) => ({ i, t: t0 + i })) })
/** Lets the cache's queued writes finish. */
const drained = (c: IdleCache) => c.idle()

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('opening the cache', () => {
  it('gives up when another tab blocks the open, and closes a late success', async () => {
    let late: (() => void) | undefined
    const db = install((req, db) => {
      req.onblocked?.()
      late = () => succeed(req, db)
    })
    expect(await openCache()).toBeNull()
    late!()
    expect(db.closed).toBe(true)
  })

  it('gives up when the open never answers', async () => {
    vi.useFakeTimers()
    install(() => {})
    const p = openCache()
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS + 1)
    expect(await p).toBeNull()
  })

  it('lets another tab upgrade or delete the database, and is empty after', async () => {
    const db = install(succeed)
    const c = (await openCache())!
    c.putDay(D0, page('g1', [1]), 'g1')
    await drained(c)
    expect(c.has(D0)).toBe(true)
    db.onversionchange?.()
    expect(db.closed).toBe(true)
    expect(c.has(D0)).toBe(false)
    expect(await c.day(D0)).toBeNull()
    c.putDay(D0 + DAY_MS, page('g1', [2]), 'g1') // nothing written to a closed database
    await drained(c)
  })
})

describe('the cache', () => {
  it('keeps whole days by date, and starts over for a new generation', async () => {
    const db = install(succeed)
    const c = (await openCache())!
    c.putDay(D0, page('g1', [1, 2]), 'g1')
    await drained(c)
    expect(c.generation).toBe('g1')
    expect(c.has(D0)).toBe(true)
    expect(await c.day(D0)).toBe(page('g1', [1, 2]))
    expect(await c.day(D0 + DAY_MS)).toBeNull()
    // Reopened: the record and the keys come back, the texts only when read.
    const again = (await (install(succeed, db), openCache()))!
    expect(again.has(D0)).toBe(true)
    expect(await again.day(D0)).toBe(page('g1', [1, 2]))
    again.putDay(D0 + DAY_MS, page('g2', [3]), 'g2')
    await drained(again)
    expect(again.generation).toBe('g2')
    expect(again.has(D0)).toBe(false)
    expect(again.has(D0 + DAY_MS)).toBe(true)
  })

  it('drops the least recently used days beyond its limit', async () => {
    install(succeed)
    const c = (await openCache())!
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let k = 0; k <= MAX_DAYS; k++) {
      vi.setSystemTime(D0 + k * DAY_MS)
      c.putDay(D0 + k * DAY_MS, page('g1', [k]), 'g1')
      if (k === 1) {
        await drained(c)
        vi.setSystemTime(D0 + 1.5 * DAY_MS)
        await c.day(D0) // the first day is read again, a day on: the second one is now the least recent
      }
    }
    await drained(c)
    expect(c.has(D0)).toBe(true)
    expect(c.has(D0 + DAY_MS)).toBe(false)
    expect(c.has(D0 + MAX_DAYS * DAY_MS)).toBe(true)
  })

  it('drops days not used for a while when it opens, and keeps those only read', async () => {
    const db = install(succeed)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(D0)
    const c = (await openCache())!
    c.putDay(D0, page('g1', [1]), 'g1')
    c.putDay(D0 + DAY_MS, page('g1', [2]), 'g1')
    await drained(c)
    // A while later the first day is read (not written): that use is saved too.
    vi.setSystemTime(D0 + UNUSED_MS - DAY_MS)
    expect(await c.day(D0)).not.toBeNull()
    await drained(c)
    // Opened again after the second day went unused for longer than the limit.
    vi.setSystemTime(D0 + UNUSED_MS + DAY_MS)
    const again = (await (install(succeed, db), openCache()))!
    expect(again.has(D0)).toBe(true)
    expect(again.has(D0 + DAY_MS)).toBe(false)
    expect(db.stores.get('days')!.size).toBe(1)
  })

  it('drops rows of days settled since when it merges the stretch', async () => {
    install(succeed)
    const c = (await openCache())!
    const today = D0 + 3 * DAY_MS
    const before = page('g1', [1], today - 3_600_000) // yesterday 23:00
    const after = (k: number) => page('g1', [100 + k], today + 3_600_000)
    // The stretch begins before midnight; a day later it is merged.
    c.putRecent(today - 3_600_000, today + 60_000, [before], 'g1', today + 60_000)
    await drained(c)
    const later = today + 2 * 3_600_000
    for (let k = 0; k <= MAX_PIECES; k++) c.putRecent(today + k * 60_000, today + (k + 1) * 60_000, [after(k)], 'g1', later)
    await drained(c)
    expect(c.recent()!.lo).toBe(today)
    const texts = (await c.stretch())?.texts ?? []
    expect(texts.length).toBe(1)
    expect((JSON.parse(texts[0]) as { rows: { i: number }[] }).rows.some((r) => r.i === 1)).toBe(false)
  })

  it('reads the record each write: a tab writing after another keeps its days', async () => {
    const db = install(succeed)
    const a = (await openCache())!
    const b = (await (install(succeed, db), openCache()))!
    a.putDay(D0, page('g1', [1]), 'g1')
    await drained(a)
    b.putDay(D0 + DAY_MS, page('g1', [2]), 'g1') // b opened before a wrote: its own view is stale
    await drained(b)
    const again = (await (install(succeed, db), openCache()))!
    expect(again.has(D0)).toBe(true)
    expect(again.has(D0 + DAY_MS)).toBe(true)
    // A tab writing under a newer generation empties what the other wrote, as it should.
    a.putDay(D0 + 2 * DAY_MS, page('g2', [3]), 'g2')
    await drained(a)
    const after = (await (install(succeed, db), openCache()))!
    expect(after.generation).toBe('g2')
    expect(after.has(D0)).toBe(false)
  })

  it('keeps one stretch of the newest rows: joined while it meets, started again after a gap, trimmed to what is not settled', async () => {
    install(succeed)
    const c = (await openCache())!
    const now = D0 + 3 * DAY_MS + 12 * 3_600_000
    const today = D0 + 3 * DAY_MS
    c.putRecent(today + 3_600_000, today + 2 * 3_600_000, [page('g1', [1])], 'g1', now)
    c.putRecent(today + 2 * 3_600_000 - 60_000, today + 3 * 3_600_000, [page('g1', [2]), page('g1', [3])], 'g1', now)
    await drained(c)
    expect(c.recent()).toEqual({ lo: today + 3_600_000, hi: today + 3 * 3_600_000 })
    expect(((await c.stretch())?.texts ?? []).length).toBe(2) // the second piece holds its two pages as one
    // A gap: the stretch starts again from the new range.
    c.putRecent(today + 5 * 3_600_000, today + 6 * 3_600_000, [page('g1', [4])], 'g1', now)
    await drained(c)
    expect(c.recent()).toEqual({ lo: today + 5 * 3_600_000, hi: today + 6 * 3_600_000 })
    expect(((await c.stretch())?.texts ?? []).length).toBe(1)
    // A day later, what was today is settled: only rows after it stay in the stretch.
    const later = now + DAY_MS
    c.putRecent(today + 6 * 3_600_000, today + DAY_MS + 2 * 3_600_000, [page('g1', [5])], 'g1', later)
    await drained(c)
    expect(c.recent()).toEqual({ lo: today + DAY_MS, hi: today + DAY_MS + 2 * 3_600_000 })
  })

  it('merges the stretch into one piece once it has many', async () => {
    install(succeed)
    const c = (await openCache())!
    const now = D0 + 3 * DAY_MS + 23 * 3_600_000
    const t0 = D0 + 3 * DAY_MS
    for (let k = 0; k <= MAX_PIECES; k++) c.putRecent(t0 + k * 60_000, t0 + (k + 1) * 60_000, [page('g1', [k, k + 1], t0)], 'g1', now)
    await drained(c)
    const texts = (await c.stretch())?.texts ?? []
    expect(texts.length).toBe(1)
    expect((JSON.parse(texts[0]) as { rows: { i: number }[] }).rows.map((r) => r.i)).toEqual(Array.from({ length: MAX_PIECES + 2 }, (_, k) => k))
    expect(c.recent()).toEqual({ lo: t0, hi: t0 + (MAX_PIECES + 1) * 60_000 })
  })

  it('leaves a stretch another tab started over while it merged', async () => {
    const db = install(succeed)
    const c = (await openCache())!
    const now = D0 + 3 * DAY_MS + 23 * 3_600_000
    const t0 = D0 + 3 * DAY_MS
    // Another tab's stretch, after a gap: it replaced every piece and the record.
    const theirs = { lo: t0 + 5 * 3_600_000, hi: t0 + 6 * 3_600_000 }
    const blob = await gzip(page('g1', [999], theirs.lo))
    db.beforeTransaction = (scope, mode) => {
      // The merge's write: the other tab got in between its read and this.
      if (mode !== 'readwrite' || scope.includes('days')) return
      db.beforeTransaction = null
      db.stores.get('recent')!.clear()
      db.stores.get('recent')!.set(JSON.stringify(theirs.lo), { hi: theirs.hi, blob })
      db.stores.get('meta')!.set(JSON.stringify('state'), { generation: 'g1', recent: theirs })
    }
    for (let k = 0; k <= MAX_PIECES; k++) c.putRecent(t0 + k * 60_000, t0 + (k + 1) * 60_000, [page('g1', [k], t0)], 'g1', now)
    await drained(c)
    expect(db.beforeTransaction).toBeNull() // the merge ran
    const s = await c.stretch()
    expect(s?.span).toEqual(theirs)
    expect(s?.texts.map((t) => (JSON.parse(t) as { rows: { i: number }[] }).rows.map((r) => r.i))).toEqual([[999]])
  })

  it("reads the stretch's range and texts together, as stored, not as this tab last saw them", async () => {
    const db = install(succeed)
    const a = (await openCache())!
    const b = (await (install(succeed, db), openCache()))!
    const today = D0 + 3 * DAY_MS
    const now = today + 12 * 3_600_000
    a.putRecent(today + 3_600_000, today + 2 * 3_600_000, [page('g1', [1])], 'g1', now)
    await drained(a)
    // Another tab starts the stretch over, after a gap.
    b.putRecent(today + 5 * 3_600_000, today + 6 * 3_600_000, [page('g1', [2])], 'g1', now)
    await drained(b)
    expect(a.recent()).toEqual({ lo: today + 3_600_000, hi: today + 2 * 3_600_000 }) // as a last saw it
    const s = await a.stretch()
    expect(s?.span).toEqual({ lo: today + 5 * 3_600_000, hi: today + 6 * 3_600_000 })
    expect(s?.texts).toEqual([page('g1', [2])])
    expect(a.recent()).toEqual(s?.span)
  })

  it('claims nothing a failed write did not store', async () => {
    const db = install(succeed)
    const c = (await openCache())!
    c.putDay(D0, page('g1', [1]), 'g1')
    await drained(c)
    db.failPuts = true
    c.putDay(D0 + DAY_MS, page('g1', [2]), 'g1')
    c.putRecent(D0 + 2 * DAY_MS, D0 + 2 * DAY_MS + 60_000, [page('g1', [3])], 'g1', D0 + 2 * DAY_MS + 120_000)
    await drained(c)
    expect(c.has(D0 + DAY_MS)).toBe(false)
    expect(c.recent()).toBeNull()
    // Reopened from what was stored: the same.
    db.failPuts = false
    const again = (await (install(succeed, db), openCache()))!
    expect(again.has(D0)).toBe(true)
    expect(again.has(D0 + DAY_MS)).toBe(false)
    expect(again.recent()).toBeNull()
  })

  it('merges pages into one, each row once', () => {
    const merged = JSON.parse(mergePages([page('g1', [1, 2]), page('g1', [2, 3])])) as { generation: string; rows: { i: number }[] }
    expect(merged.generation).toBe('g1')
    expect(merged.rows.map((r) => r.i)).toEqual([1, 2, 3])
  })
})
