// IndexedDB read-through cache of the API's row texts (D-184), in front of
// /observations: whole past UTC days as /observations/day sent them, keyed by
// date, and the newest stretch of a rolling window (not settled yet, so
// paged) as the pages that brought it. Only a day the server sent as final
// (immutable) is stored, and a stored day is complete, since final days
// never change within a generation: a date is either there or fetched. The
// stretch records the range it holds completely, and only rows after it are
// asked for. Texts are the API's own, so any engine build reads them; a new
// generation empties the cache. Each write reads the record and stores its
// texts and the record in one transaction, so a failed write claims nothing
// and tabs writing at once do not undo each other. Best effort: without
// storage the app works the same, from the network.
import { gunzip, gzip } from './compress'
import { settledUntil } from './slices'

const DB = 'meshmap-cache'
// 2: each day's record holds when it was last used (1 kept a shared map, which tabs overwrote).
const VERSION = 2
/** The database of the cache before D-184 (hourly copies of the engine's rows), deleted on open. */
const OLD_DB = 'meshmap-derive'
/** Days kept, the least recently used dropped beyond: the longest window and more, a few MB each at most. */
export const MAX_DAYS = 31
/** A day not used for this long is dropped when the cache opens: a visitor away a while finds no stale days left. */
export const UNUSED_MS = 30 * 86_400_000
/** A read saves when its day was used at most this often. */
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
  /** The generation of what is stored, as last seen; null when empty. */
  readonly generation: string | null
  has(day: number): boolean
  /** A stored day's text, or null. */
  day(day: number): Promise<string | null>
  /** A day the server sent as final. */
  putDay(day: number, text: string, generation: string): void
  /** The range the stretch held completely when this tab last looked (another tab may have changed it since), or null. */
  recent(): Span | null
  /**
   * The stretch as stored now: the range it holds completely and its page
   * texts, read together. Null when there is none (or it is of another
   * generation, or cannot be read).
   */
  stretch(): Promise<{ span: Span; texts: string[] } | null>
  /** Pages holding every row of [lo, hi): they join the stretch, or start it again when they do not meet it. */
  putRecent(lo: number, hi: number, texts: string[], generation: string, now: number): void
  clear(): void
}

/** The IndexedDB cache, which can also say when its queued writes are done (tests). */
export interface IdleCache extends RowCache {
  idle(): Promise<void>
}

interface Meta {
  generation: string | null
  recent: Span | null
}
type DayRecord = { blob: Blob; used: number }
type Piece = { hi: number; blob: Blob }

const EMPTY: Meta = { generation: null, recent: null }

/**
 * Merges page texts into one page: their rows at or after `from`, each id
 * once, under the first one's window and generation.
 */
export function mergePages(texts: string[], from = -Infinity): string {
  if (texts.length === 1 && from === -Infinity) return texts[0]
  const pages = texts.map((t) => JSON.parse(t) as { window: unknown; generation: string; rows?: { i: number; t: number }[] | null })
  const seen = new Set<number>()
  const rows: { i: number; t: number }[] = []
  for (const p of pages)
    for (const r of p.rows ?? []) {
      if (r.t < from || seen.has(r.i)) continue
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

class IdbCache implements IdleCache {
  private writes: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(
    private db: IDBDatabase,
    private meta: Meta, // as last read or written by this tab
    private days: Set<number>,
  ) {
    // Another tab upgrades or deletes the database (Settings → Reset): let it,
    // and carry on without a cache.
    db.onversionchange = () => {
      this.closed = true
      db.close()
    }
  }

  get generation() {
    return this.closed ? null : this.meta.generation
  }

  has(day: number) {
    return !this.closed && this.days.has(day)
  }

  recent(): Span | null {
    return !this.closed && this.meta.recent ? { ...this.meta.recent } : null
  }

  /**
   * Writes run one at a time, in call order; failures are swallowed (a
   * failed write claims nothing). Compression happens before, outside the
   * queue; reads do not wait for it (what they miss is fetched).
   */
  private write(fn: () => Promise<void>) {
    this.writes = this.writes.then(() => (this.closed ? undefined : fn())).catch(() => {})
  }

  async idle() {
    // A write may queue another (a merge after a stretch's write): until none is left.
    for (let w = this.writes; ; w = this.writes) {
      await w
      if (w === this.writes) return
    }
  }

  async day(day: number): Promise<string | null> {
    if (!this.has(day)) return null
    const at = Date.now()
    try {
      const rec = await settle(this.db.transaction('days').objectStore('days').get(day) as IDBRequest<DayRecord | undefined>)
      if (!rec) {
        this.days.delete(day) // another tab dropped it
        return null
      }
      // Saved now and then, so a day that is only read does not look unused when the cache next opens.
      if (at - rec.used > USE_SAVE_MS) {
        this.write(async () => {
          const tx = this.db.transaction('days', 'readwrite')
          const now = await settle(tx.objectStore('days').get(day) as IDBRequest<DayRecord | undefined>)
          if (now) tx.objectStore('days').put({ ...now, used: Math.max(now.used, at) }, day)
          await done(tx)
        })
      }
      return await gunzip(rec.blob)
    } catch {
      return null
    }
  }

  async stretch(): Promise<{ span: Span; texts: string[] } | null> {
    if (this.closed) return null
    try {
      // In one transaction: another tab may start the stretch over or merge it between two.
      const { meta, pieces } = await this.readStretch(this.db.transaction(['recent', 'meta']))
      if (meta.generation !== this.meta.generation) return null // the next write starts over
      this.meta = { ...this.meta, recent: meta.recent }
      if (!meta.recent) return null
      return { span: { ...meta.recent }, texts: await Promise.all(pieces.map((p) => gunzip(p.blob))) }
    } catch {
      return null
    }
  }

  /** The record and the stretch's pieces (with their keys), as stored. */
  private async readStretch(tx: IDBTransaction): Promise<{ meta: Meta; keys: number[]; pieces: Piece[] }> {
    const [meta, keys, pieces] = await Promise.all([
      settle(tx.objectStore('meta').get('state') as IDBRequest<Meta | undefined>),
      settle(tx.objectStore('recent').getAllKeys() as IDBRequest<number[]>),
      settle(tx.objectStore('recent').getAll() as IDBRequest<Piece[]>),
    ])
    return { meta: meta ?? EMPTY, keys, pieces }
  }

  /**
   * The record as stored, inside a write: for another generation (another
   * tab's, or a new one), the cache is emptied first.
   */
  private async current(tx: IDBTransaction, generation: string | null): Promise<Meta> {
    const m = (await settle(tx.objectStore('meta').get('state') as IDBRequest<Meta | undefined>)) ?? EMPTY
    if (m.generation === generation) return m
    tx.objectStore('days').clear()
    tx.objectStore('recent').clear()
    return { generation, recent: null }
  }

  putDay(day: number, text: string, generation: string) {
    if (this.closed) return
    const at = Date.now()
    const blob = gzip(text)
    blob.catch(() => {})
    this.write(async () => {
      const b = await blob
      const tx = this.db.transaction(['days', 'recent', 'meta'], 'readwrite')
      const days = tx.objectStore('days')
      const meta = await this.current(tx, generation)
      days.put({ blob: b, used: at }, day)
      // Beyond the limit, the least recently used go.
      const [keys, recs] = await Promise.all([settle(days.getAllKeys() as IDBRequest<number[]>), settle(days.getAll() as IDBRequest<DayRecord[]>)])
      const evict = keys
        .map((d, k) => [d, recs[k].used] as const)
        .filter(([d]) => d !== day)
        .sort((a, b) => a[1] - b[1])
        .slice(0, Math.max(0, keys.length - MAX_DAYS))
        .map(([d]) => d)
      for (const d of evict) days.delete(d)
      tx.objectStore('meta').put(meta, 'state')
      await done(tx)
      this.meta = meta
      this.days = new Set(keys.filter((d) => !evict.includes(d)))
    })
  }

  putRecent(lo: number, hi: number, texts: string[], generation: string, now: number) {
    if (this.closed || hi <= lo || !texts.length) return
    const blob = gzip(mergePages(texts))
    blob.catch(() => {})
    this.write(async () => {
      const b = await blob
      const tx = this.db.transaction(['days', 'recent', 'meta'], 'readwrite')
      const recent = tx.objectStore('recent')
      const meta = await this.current(tx, generation)
      // Rows of settled days come as whole days: the stretch starts at the first day that is not.
      const settled = settledUntil(now)
      const r = meta.recent
      const joins = !!r && lo <= r.hi && hi >= r.lo
      const span = { lo: Math.max(joins ? Math.min(r!.lo, lo) : lo, settled), hi: joins ? Math.max(r!.hi, hi) : hi }
      // Pieces that end in a settled day, or every piece when the new one does not meet them, go.
      const [keys, pieces] = await Promise.all([settle(recent.getAllKeys() as IDBRequest<number[]>), settle(recent.getAll() as IDBRequest<Piece[]>)])
      const drop = keys.filter((_, k) => !joins || pieces[k].hi <= settled)
      for (const l of drop) recent.delete(l)
      recent.put({ hi, blob: b }, lo)
      const next = { ...meta, recent: span.hi > span.lo ? span : null }
      tx.objectStore('meta').put(next, 'state')
      await done(tx)
      this.meta = next
      if (keys.length - drop.length + 1 > MAX_PIECES) this.compact(generation)
    })
  }

  /**
   * Merges the stretch's pieces into one, keeping only rows from the
   * stretch's start: a piece that straddled midnight would otherwise carry
   * its settled day's rows on from merge to merge. The texts are merged
   * outside a transaction (one cannot wait on compression), so the merge is
   * written only if the stretch is still the one read: another tab that
   * started it over or trimmed it meanwhile would otherwise have its piece
   * overwritten, and the record claim rows nothing holds.
   */
  private compact(generation: string) {
    this.write(async () => {
      const read = await this.readStretch(this.db.transaction(['recent', 'meta']))
      const lo = read.meta.recent?.lo
      if (read.meta.generation !== generation || lo === undefined || !read.pieces.length) return
      const merged = await gzip(mergePages(await Promise.all(read.pieces.map((p) => gunzip(p.blob))), lo))
      const tx = this.db.transaction(['recent', 'meta'], 'readwrite')
      const now = await this.readStretch(tx)
      const hiOf = new Map(now.keys.map((k, i) => [k, now.pieces[i].hi]))
      const same = now.meta.generation === generation && now.meta.recent?.lo === lo && read.keys.every((k, i) => hiOf.get(k) === read.pieces[i].hi)
      if (!same) return // another tab moved on meanwhile: its stretch stays as it wrote it
      for (const l of read.keys) tx.objectStore('recent').delete(l) // pieces another tab added since stay
      tx.objectStore('recent').put({ hi: Math.max(...read.pieces.map((p) => p.hi)), blob: merged }, lo)
      await done(tx)
    })
  }

  clear() {
    this.write(async () => {
      const tx = this.db.transaction(['days', 'recent', 'meta'], 'readwrite')
      tx.objectStore('days').clear()
      tx.objectStore('recent').clear()
      tx.objectStore('meta').put(EMPTY, 'state')
      await done(tx)
      this.meta = { ...EMPTY }
      this.days.clear()
    })
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
      // A cache: a new format starts empty.
      for (const s of ['days', 'recent', 'meta']) {
        if (db.objectStoreNames.contains(s)) db.deleteObjectStore(s)
        db.createObjectStore(s)
      }
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

/**
 * Opens the cache: its record and its days' keys, dropping the days not used
 * for UNUSED_MS; texts are read when a window needs them. Null without storage.
 */
export async function openCache(now = Date.now()): Promise<IdleCache | null> {
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
    const tx = db.transaction(['days', 'meta'], 'readwrite')
    const days = tx.objectStore('days')
    const [meta, keys, recs] = await Promise.all([
      settle(tx.objectStore('meta').get('state') as IDBRequest<Meta | undefined>),
      settle(days.getAllKeys() as IDBRequest<number[]>),
      settle(days.getAll() as IDBRequest<DayRecord[]>),
    ])
    const stale = keys.filter((_, k) => recs[k].used < now - UNUSED_MS)
    for (const d of stale) days.delete(d)
    await done(tx)
    return new IdbCache(db, meta ?? { ...EMPTY }, new Set(keys.filter((d) => !stale.includes(d))))
  } catch {
    db.close()
    return null
  }
}
