// @vitest-environment node
// The read-through cache (D-184) against a minimal in-memory IndexedDB
// stand-in: only what it uses, with transactions completing (or aborting) on
// a later tick, and a failed put aborting the whole transaction.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_DAYS, MAX_PIECES, mergePages, OPEN_TIMEOUT_MS, openCache, UNUSED_MS, type RowCache } from '../src/derive/cache'
import { DAY_MS } from '../src/derive/slices'

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
  close() {
    this.closed = true
  }
  transaction(names: string | string[]) {
    if (this.closed) throw new Error('InvalidStateError: the database is closed')
    const stores = this.stores, failPuts = this.failPuts
    // Changes apply when the transaction completes, all or none.
    const pending: (() => void)[] = []
    let failed = false
    const tx = {
      error: null as unknown,
      oncomplete: null as Handler,
      onerror: null as Handler,
      onabort: null as Handler,
      objectStore(name: string) {
        if (!([] as string[]).concat(names).includes(name)) throw new Error(`${name} not in this transaction`)
        const s = stores.get(name)!
        const req = (v: () => unknown) => {
          const r = new FakeRequest()
          setTimeout(() => {
            r.result = v()
            r.onsuccess?.()
          }, 0)
          return r
        }
        const sorted = () => [...s.entries()].sort((a, b) => Number(JSON.parse(a[0])) - Number(JSON.parse(b[0])))
        return {
          getAllKeys: () => req(() => sorted().map(([k]) => JSON.parse(k))),
          getAll: () => req(() => sorted().map(([, v]) => v)),
          get: (k: unknown) => req(() => s.get(JSON.stringify(k))),
          put: (v: unknown, k: unknown) => {
            if (failPuts && name !== 'meta') failed = true
            pending.push(() => s.set(JSON.stringify(k), v))
          },
          delete: (k: unknown) => void pending.push(() => s.delete(JSON.stringify(k))),
          clear: () => void pending.push(() => s.clear()),
        }
      },
    }
    setTimeout(() => {
      if (failed) {
        tx.error = new DOMException('quota', 'QuotaExceededError')
        tx.onabort?.()
        return
      }
      for (const f of pending) f()
      tx.oncomplete?.()
    }, 5)
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
const page = (gen: string, ids: number[]) => JSON.stringify({ window: { start: 'a', end: 'b' }, generation: gen, rows: ids.map((i) => ({ i, t: D0 + i })) })
/** Lets the cache's queued writes finish. */
const drained = async (c: RowCache) => {
  await c.recentTexts()
  await new Promise((r) => setTimeout(r, 20))
}

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
      vi.setSystemTime(D0 + k * 1000)
      c.putDay(D0 + k * DAY_MS, page('g1', [k]), 'g1')
      if (k === 1) {
        vi.setSystemTime(D0 + 1500)
        await c.day(D0) // the first day is read again: the second one is now the least recent
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

  it('keeps one stretch of the newest rows: joined while it meets, started again after a gap, trimmed to what is not settled', async () => {
    install(succeed)
    const c = (await openCache())!
    const now = D0 + 3 * DAY_MS + 12 * 3_600_000
    const today = D0 + 3 * DAY_MS
    c.putRecent(today + 3_600_000, today + 2 * 3_600_000, [page('g1', [1])], 'g1', now)
    c.putRecent(today + 2 * 3_600_000 - 60_000, today + 3 * 3_600_000, [page('g1', [2]), page('g1', [3])], 'g1', now)
    await drained(c)
    expect(c.recent()).toEqual({ lo: today + 3_600_000, hi: today + 3 * 3_600_000 })
    expect((await c.recentTexts()).length).toBe(2) // the second piece holds its two pages as one
    // A gap: the stretch starts again from the new range.
    c.putRecent(today + 5 * 3_600_000, today + 6 * 3_600_000, [page('g1', [4])], 'g1', now)
    await drained(c)
    expect(c.recent()).toEqual({ lo: today + 5 * 3_600_000, hi: today + 6 * 3_600_000 })
    expect((await c.recentTexts()).length).toBe(1)
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
    for (let k = 0; k <= MAX_PIECES; k++) c.putRecent(t0 + k * 60_000, t0 + (k + 1) * 60_000, [page('g1', [k, k + 1])], 'g1', now)
    await drained(c)
    const texts = await c.recentTexts()
    expect(texts.length).toBe(1)
    expect((JSON.parse(texts[0]) as { rows: { i: number }[] }).rows.map((r) => r.i)).toEqual(Array.from({ length: MAX_PIECES + 2 }, (_, k) => k))
    expect(c.recent()).toEqual({ lo: t0, hi: t0 + (MAX_PIECES + 1) * 60_000 })
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
