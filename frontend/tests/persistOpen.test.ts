// @vitest-environment node
// openPersistence against a minimal in-memory IndexedDB stand-in: only what
// it uses, with transactions completing (or aborting) on a later tick.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOUR_MS, OPEN_TIMEOUT_MS, openPersistence, type Source } from '../src/derive/persist'

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
  stores = new Map<string, Map<string, unknown>>([['chunks', new Map()], ['deltas', new Map()], ['meta', new Map()]])
  failRows = false // puts of rows fail, as when the quota is exceeded
  closed = false
  transactions = 0
  onversionchange: Handler = null
  objectStoreNames = { contains: (n: string) => this.stores.has(n) }
  close() {
    this.closed = true
  }
  transaction(names: string | string[]) {
    if (this.closed) throw new Error('InvalidStateError: the database is closed')
    this.transactions++
    const stores = this.stores, failRows = this.failRows
    let failed = false
    const tx = {
      error: null as unknown,
      oncomplete: null as Handler,
      onerror: null as Handler,
      onabort: null as Handler,
      objectStore(name: string) {
        if (!([] as string[]).concat(names).includes(name)) throw new Error(`${name} not in this transaction`)
        const s = stores.get(name)!
        const req = (v: unknown) => Object.assign(new FakeRequest(), { result: v })
        return {
          getAllKeys: () => req([...s.keys()].map((k) => JSON.parse(k))),
          getAll: () => req([...s.values()]),
          get: (k: unknown) => req(s.get(JSON.stringify(k))),
          put: (v: unknown, k: unknown) => {
            if (failRows && name !== 'meta') failed = true
            else s.set(JSON.stringify(k), v)
          },
          delete: (k: unknown) => void (typeof k === 'object' && k && 'range' in k ? undefined : s.delete(JSON.stringify(k))),
          clear: () => s.clear(),
        }
      },
    }
    setTimeout(() => {
      if (failed) {
        tx.error = new DOMException('quota', 'QuotaExceededError')
        tx.onabort?.()
      } else tx.oncomplete?.()
    }, 0)
    return tx
  }
}

/** Installs the stand-in; `answer` decides what the open request does. */
function install(answer: (req: FakeRequest, db: FakeDB) => void): FakeDB {
  const db = new FakeDB()
  vi.stubGlobal('indexedDB', {
    open: () => {
      const req = new FakeRequest()
      setTimeout(() => answer(req, db), 0)
      return req
    },
  })
  vi.stubGlobal('IDBKeyRange', { bound: () => ({ range: true }), upperBound: () => ({ range: true }) })
  return db
}
const succeed = (req: FakeRequest, db: FakeDB) => {
  req.result = db
  req.onsuccess?.()
}

const T0 = Date.parse('2026-11-05T10:00:00Z')
const src = (rows: { t: number }[]): Source => ({
  takeDirty: () => [...new Set(rows.map((r) => Math.floor(r.t / HOUR_MS) * HOUR_MS))],
  exportRange: (lo, hi) => JSON.stringify(rows.filter((r) => r.t >= lo && r.t < hi)),
  newestT: () => rows.at(-1)?.t ?? 0,
})
const meta = (db: FakeDB) => db.stores.get('meta')!.get(JSON.stringify('state')) as { cov: unknown } | undefined

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('opening the saved copy', () => {
  it('gives up when another tab blocks the open, and closes a late success', async () => {
    let late: (() => void) | undefined
    const db = install((req, db) => {
      req.onblocked?.()
      late = () => succeed(req, db)
    })
    expect(await openPersistence('e1')).toBeNull()
    late!()
    expect(db.closed).toBe(true)
  })

  it('gives up when the open never answers', async () => {
    vi.useFakeTimers()
    install(() => {})
    const p = openPersistence('e1')
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS + 1)
    expect(await p).toBeNull()
  })

  it('lets another tab upgrade or delete the database, and writes nothing after', async () => {
    const db = install(succeed)
    const p = (await openPersistence('e1'))!
    expect(p).not.toBeNull()
    db.onversionchange?.()
    expect(db.closed).toBe(true)
    const before = db.transactions
    await p.flush(src([{ t: T0 }])) // no transaction on the closed database
    expect(db.transactions).toBe(before)
  })
})

describe('a failed row write', () => {
  it('leaves a coverage record that claims nothing', async () => {
    const db = install(succeed)
    const p = (await openPersistence('e1'))!
    const rows = [{ t: T0 }, { t: T0 + HOUR_MS }]
    p.meta({ lo: T0, hi: T0 + 2 * HOUR_MS }, 'g1')
    await p.flush(src(rows))
    expect(meta(db)?.cov).toEqual({ lo: T0, hi: T0 + 2 * HOUR_MS })

    db.failRows = true
    await p.flush(src([...rows, { t: T0 + 2 * HOUR_MS }]))
    expect(meta(db)?.cov).toBeNull() // the next load fetches its window afresh
    p.meta({ lo: T0, hi: T0 + 3 * HOUR_MS }, 'g1')
    await p.flush(src([]))
    expect(meta(db)?.cov).toBeNull()

    // A reset stores nothing, so nothing is missing: coverage counts again.
    db.failRows = false
    p.reset()
    p.meta({ lo: T0, hi: T0 + HOUR_MS }, 'g2')
    await p.flush(src([]))
    expect(meta(db)?.cov).toEqual({ lo: T0, hi: T0 + HOUR_MS })
  })
})
