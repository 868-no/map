// IndexedDB read-through cache of the API's row texts (D-184), in front of
// /observations: whole past UTC days as /observations/day sent them, keyed by
// date, and the newest stretch of a rolling window (not settled yet, so
// paged) as the pages that brought it. A stored day is complete, since days
// never change within a generation: a date is either there or fetched. The
// stretch records the range it holds completely, and only rows after it are
// asked for. Texts are the API's own, so any engine build reads them; a new
// generation empties the cache. Each write stores its texts and the record
// describing them in one transaction, so a failed write claims nothing.
// Best effort: without storage the app works the same, from the network.
import { gunzip, gzip } from './compress'
import { settledUntil } from './slices'

const DB = 'meshmap-cache'
const VERSION = 1
/** The database of the cache before D-184 (hourly copies of the engine's rows), deleted on open. */
const OLD_DB = 'meshmap-derive'
/** Days kept, the least recently used dropped beyond: the longest window and more, a few MB each at most. */
export const MAX_DAYS = 31
/** A day not used for this long is dropped when the cache opens: a visitor away a while finds no stale days left. */
export const UNUSED_MS = 30 * 86_400_000
/** A read saves when its day was last used at most this often (it is otherwise saved with the next write). */
const USE_SAVE_MS = 86_400_000
/** Pieces the stretch may collect (about one per minute's sync) before they are merged into one. */
export const MAX_PIECES = 30
/** An open that neither succeeds nor fails in this long (blocked by another tab) gives up: no cache this time. */
export const OPEN_TIMEOUT_MS = 5000

/** A time range [lo, hi), Unix ms. */
export interface Span {
  lo: number
  hi: number
}

/** What the fetcher needs of the cache (the IndexedDB one, or a stand-in in tests). */
export interface RowCache {
  /** The generation of what is stored; null when empty. */
  readonly generation: string | null
  has(day: number): boolean
  /** A stored day's text, or null. */
  day(day: number): Promise<string | null>
  putDay(day: number, text: string, generation: string): void
  /** The range the stretch holds completely, or null. */
  recent(): Span | null
  /** The stretch's page texts. */
  recentTexts(): Promise<string[]>
  /** Pages holding every row of [lo, hi): they join the stretch, or start it again when they do not meet it. */
  putRecent(lo: number, hi: number, texts: string[], generation: string, now: number): void
  clear(): void
}

interface State {
  generation: string | null
  recent: Span | null
  used: Record<string, number> // day -> when last read or written
}
type Piece = { hi: number; blob: Blob }

const EMPTY: State = { generation: null, recent: null, used: {} }

/** Merges page texts into one page: their rows, each id once, under the first one's window and generation. */
export function mergePages(texts: string[]): string {
  if (texts.length === 1) return texts[0]
  const pages = texts.map((t) => JSON.parse(t) as { window: unknown; generation: string; rows?: { i: number }[] | null })
  const seen = new Set<number>()
  const rows: { i: number }[] = []
  for (const p of pages)
    for (const r of p.rows ?? []) {
      if (seen.has(r.i)) continue
      seen.add(r.i)
      rows.push(r)
    }
  return JSON.stringify({ window: pages[0].window, generation: pages[0].generation, rows })
}

const settle = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error)
  })

class IdbCache implements RowCache {
  private chain: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(
    private db: IDBDatabase,
    private state: State,
    private days: Set<number>,
    private pieces: Map<number, number>, // the stretch's pieces: lo -> hi
  ) {
    // Another tab upgrades or deletes the database (Settings → Reset): let it,
    // and carry on without a cache.
    db.onversionchange = () => {
      this.closed = true
      db.close()
    }
  }

  get generation() {
    return this.closed ? null : this.state.generation
  }

  has(day: number) {
    return !this.closed && this.days.has(day)
  }

  recent(): Span | null {
    return !this.closed && this.state.recent ? { ...this.state.recent } : null
  }

  /** One operation at a time, in call order: a read sees every write asked for before it. Failures are swallowed. */
  private run<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    const p = this.chain.then(() => (this.closed ? fallback : fn())).catch(() => fallback)
    this.chain = p
    return p
  }

  day(day: number): Promise<string | null> {
    const at = Date.now() // when it was asked for, not when the queue reached it
    return this.run(async () => {
      if (!this.days.has(day)) return null
      const blob = await settle(this.db.transaction('days').objectStore('days').get(day) as IDBRequest<Blob | undefined>)
      if (!blob) return null
      const before = this.state.used[day] ?? 0
      this.state.used[day] = at
      // Saved now and then, so a day that is only read does not look unused when the cache next opens.
      if (at - before > USE_SAVE_MS) {
        const tx = this.db.transaction('meta', 'readwrite')
        tx.objectStore('meta').put(this.state, 'state')
        await done(tx)
      }
      return gunzip(blob)
    }, null)
  }

  recentTexts(): Promise<string[]> {
    return this.run(async () => {
      const pieces = await settle(this.db.transaction('recent').objectStore('recent').getAll() as IDBRequest<Piece[]>)
      return Promise.all(pieces.map((p) => gunzip(p.blob)))
    }, [])
  }

  /** Empties every store, for a new generation (null: none). */
  private async wipe(generation: string | null) {
    const tx = this.db.transaction(['days', 'recent', 'meta'], 'readwrite')
    tx.objectStore('days').clear()
    tx.objectStore('recent').clear()
    const state = { ...EMPTY, used: {}, generation }
    tx.objectStore('meta').put(state, 'state')
    await done(tx)
    this.state = state
    this.days.clear()
    this.pieces.clear()
  }

  putDay(day: number, text: string, generation: string) {
    const at = Date.now()
    void this.run(async () => {
      const blob = await gzip(text)
      if (generation !== this.state.generation) await this.wipe(generation)
      const used: Record<string, number> = { ...this.state.used, [day]: at }
      const evict = Object.keys(used)
        .map(Number)
        .filter((d) => d !== day)
        .sort((a, b) => used[a] - used[b])
        .slice(0, Math.max(0, Object.keys(used).length - MAX_DAYS))
      for (const d of evict) delete used[d]
      const state = { ...this.state, used }
      const tx = this.db.transaction(['days', 'meta'], 'readwrite')
      tx.objectStore('days').put(blob, day)
      for (const d of evict) tx.objectStore('days').delete(d)
      tx.objectStore('meta').put(state, 'state')
      await done(tx)
      this.state = state
      this.days.add(day)
      for (const d of evict) this.days.delete(d)
    }, undefined)
  }

  putRecent(lo: number, hi: number, texts: string[], generation: string, now: number) {
    if (hi <= lo || !texts.length) return
    void this.run(async () => {
      if (generation !== this.state.generation) await this.wipe(generation)
      // Rows of settled days come as whole days: the stretch starts at the first day that is not.
      const settled = settledUntil(now)
      const r = this.state.recent
      const joins = !!r && lo <= r.hi && hi >= r.lo
      const span = { lo: Math.max(joins ? Math.min(r!.lo, lo) : lo, settled), hi: joins ? Math.max(r!.hi, hi) : hi }
      // Pieces that end in a settled day, or every piece when the new one does not meet them, go.
      const drop = [...this.pieces].filter(([, h]) => !joins || h <= settled).map(([l]) => l)
      const kept = [...this.pieces.keys()].filter((l) => !drop.includes(l))
      let writes: [number, Piece][]
      if (kept.length + 1 > MAX_PIECES) {
        // Merged into one, the stretch's rows each once.
        const tx = this.db.transaction('recent')
        const [keys, old] = await Promise.all([
          settle(tx.objectStore('recent').getAllKeys() as IDBRequest<number[]>),
          settle(tx.objectStore('recent').getAll() as IDBRequest<Piece[]>),
        ])
        const oldTexts = await Promise.all(old.filter((_, k) => kept.includes(keys[k])).map((p) => gunzip(p.blob)))
        writes = [[span.lo, { hi: span.hi, blob: await gzip(mergePages([...oldTexts, ...texts])) }]]
        drop.push(...kept)
      } else {
        writes = [[lo, { hi, blob: await gzip(mergePages(texts)) }]]
      }
      const state = { ...this.state, recent: span.hi > span.lo ? span : null }
      const tx = this.db.transaction(['recent', 'meta'], 'readwrite')
      for (const l of drop) tx.objectStore('recent').delete(l)
      for (const [l, p] of writes) tx.objectStore('recent').put(p, l)
      tx.objectStore('meta').put(state, 'state')
      await done(tx)
      this.state = state
      for (const l of drop) this.pieces.delete(l)
      for (const [l, p] of writes) this.pieces.set(l, p.hi)
    }, undefined)
  }

  clear() {
    void this.run(() => this.wipe(null), undefined)
  }

  /** Drops the days not used since `before` (at open). */
  prune(before: number): Promise<void> {
    return this.run(async () => {
      const stale = [...this.days].filter((d) => (this.state.used[d] ?? 0) < before)
      if (!stale.length) return
      const used = { ...this.state.used }
      for (const d of stale) delete used[d]
      const state = { ...this.state, used }
      const tx = this.db.transaction(['days', 'meta'], 'readwrite')
      for (const d of stale) tx.objectStore('days').delete(d)
      tx.objectStore('meta').put(state, 'state')
      await done(tx)
      this.state = state
      for (const d of stale) this.days.delete(d)
    }, undefined)
  }
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    // Another tab holding an older version (or a pending delete, Settings →
    // Reset) blocks the open: give up rather than wait, and close the database
    // should the open still succeed later, so it blocks no one in turn.
    let settled = false
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error('indexedDB open timed out')), OPEN_TIMEOUT_MS)
    req.onblocked = () => fail(new Error('indexedDB open blocked'))
    req.onupgradeneeded = () => {
      // Not blocked: an upgrade is under way, which a slow phone may take a
      // while to finish, so the timeout no longer applies.
      clearTimeout(timer)
      const db = req.result
      for (const s of ['days', 'recent', 'meta']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s)
    }
    req.onsuccess = () => {
      if (settled) return req.result.close()
      settled = true
      clearTimeout(timer)
      resolve(req.result)
    }
    req.onerror = () => fail(req.error)
  })
}

/** Opens the cache: its record and its keys only; texts are read when a window needs them. Null without storage. */
export async function openCache(): Promise<RowCache | null> {
  let db: IDBDatabase
  try {
    db = await open()
  } catch {
    return null
  }
  try {
    indexedDB.deleteDatabase(OLD_DB) // best effort; a tab still using it blocks this until it closes
  } catch {
    /* nothing to delete */
  }
  try {
    const tx = db.transaction(['days', 'recent', 'meta'], 'readonly')
    const [state, dayKeys, pieceKeys, pieces] = await Promise.all([
      settle(tx.objectStore('meta').get('state') as IDBRequest<State | undefined>),
      settle(tx.objectStore('days').getAllKeys() as IDBRequest<number[]>),
      settle(tx.objectStore('recent').getAllKeys() as IDBRequest<number[]>),
      settle(tx.objectStore('recent').getAll() as IDBRequest<Piece[]>),
    ])
    const cache = new IdbCache(db, state ?? { ...EMPTY, used: {} }, new Set(dayKeys), new Map(pieceKeys.map((l, k) => [l, pieces[k].hi])))
    await cache.prune(Date.now() - UNUSED_MS)
    return cache
  } catch {
    db.close()
    return null
  }
}

