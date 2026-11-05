// IndexedDB copy of the engine's rows, so a reload (or an offline start)
// begins from what was already fetched. Rows are stored per hour as gzip-
// compressed JSON (the API's row format). A flush writes only what is new:
// closed hours as one full chunk each, the open (newest) hour as small
// append-only deltas that are compacted into its chunk when the hour closes,
// after MAX_DELTAS deltas, or on the next load. Best effort: without storage
// the app works the same, only without the head start.
import type { Coverage } from './rowStore'

const DB = 'meshmap-derive'
// 2: hourly compressed chunks (1 stored one record per row). 3: adds the
// open hour's deltas; version 2 chunks are read as they are.
const VERSION = 3
export const HOUR_MS = 3_600_000
/** A delta re-exports this much before the last flush: rows may be merged slightly out of time order. */
export const DELTA_OVERLAP_MS = 10 * 60_000
/** Deltas an hour may collect before it is rewritten as one chunk. */
export const MAX_DELTAS = 60

export interface Persisted {
  chunks: Blob[] // gzip'd JSON arrays of rows (full hours and deltas; duplicates are dropped on load), decompressed one at a time by the reader
  cov: Coverage | null
  generation: string | null
}

/** What persistence needs from the engine. */
export interface Source {
  takeDirty(): number[] // hour starts with new rows
  exportRange(lo: number, hi: number): string // JSON array of rows in [lo, hi)
  newestT(): number // 0 when empty
}

/** One record to store: an hour's full chunk (replacing its deltas), or one delta. */
export type Write =
  | { hour: number; full: true; text: string } // text '[]': the hour is empty
  | { hour: number; full: false; seq: number; text: string }

/**
 * Decides what a flush writes. Per stored hour it remembers up to when rows
 * are stored (mark) and how many deltas it has (seq). Pure: no storage.
 */
export class HourWriter {
  private hours = new Map<number, { mark: number; seq: number }>()

  /** Hours already stored (with their highest delta seq), as loaded into the engine. */
  restore(stored: Map<number, number>, src: Source) {
    const until = src.newestT() + 1
    for (const [h, seq] of stored) this.hours.set(h, { mark: Math.min(h + HOUR_MS, until), seq })
  }

  /** Writes for the dirty hours, plus compaction of hours with deltas that are no longer open. */
  plan(dirty: Iterable<number>, src: Source): Write[] {
    const newest = src.newestT()
    const open = Math.floor(newest / HOUR_MS) * HOUR_MS
    const todo = new Set(dirty)
    for (const [h, s] of this.hours) if (s.seq > 0 && h < open) todo.add(h)
    const out: Write[] = []
    for (const h of [...todo].sort((a, b) => a - b)) {
      const s = this.hours.get(h)
      const end = h + HOUR_MS
      const mark = Math.min(end, newest + 1) // every row of the hour up to here is in this export
      if (s && h >= open && s.seq < MAX_DELTAS) {
        // The seq advances even when nothing is written, so the hour is
        // compacted once it closes (a row older than the overlap may be in it).
        const text = src.exportRange(Math.max(h, s.mark - DELTA_OVERLAP_MS), end)
        this.hours.set(h, { mark, seq: s.seq + 1 })
        if (text !== '[]') out.push({ hour: h, full: false, seq: s.seq + 1, text })
      } else {
        out.push({ hour: h, full: true, text: src.exportRange(h, end) })
        this.hours.set(h, { mark, seq: 0 })
      }
    }
    return out
  }

  /** Rows before t were removed: forget older hours and rewrite the partly trimmed one. */
  removedBefore(t: number, src: Source): Write[] {
    const hour = Math.floor(t / HOUR_MS) * HOUR_MS
    for (const h of this.hours.keys()) if (h < hour) this.hours.delete(h)
    this.hours.delete(hour)
    return this.plan([hour], src)
  }

  reset() {
    this.hours.clear()
  }
}

/** An open that neither succeeds nor fails in this long (blocked by another tab) gives up: no copy this time. */
export const OPEN_TIMEOUT_MS = 5000

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
    req.onupgradeneeded = (e) => {
      // Not blocked: an upgrade is under way, which a slow phone may take a
      // while to finish, so the timeout no longer applies.
      clearTimeout(timer)
      const db = req.result
      if (e.oldVersion < 2) {
        // A format change starts over: the old meta described the old rows.
        if (db.objectStoreNames.contains('rows')) db.deleteObjectStore('rows')
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks')
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
        req.transaction?.objectStore('meta').clear()
      }
      if (!db.objectStoreNames.contains('deltas')) db.createObjectStore('deltas') // keys [hour, seq]
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

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error)
  })

export const gzip = (text: string) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob()
export const gunzip = (b: Blob) => new Response(b.stream().pipeThrough(new DecompressionStream('gzip'))).text()

/** All deltas of one hour: array keys [h] < [h, seq] < [h, Infinity]. */
const deltasOf = (h: number) => IDBKeyRange.bound([h], [h, Infinity])

export interface Persistence {
  restored: Persisted
  /** Call once the restored chunks are in the engine: compacts what is left over. */
  attach(src: Source): void
  /** Write what changed (call after rows were added). */
  flush(src: Source): Promise<void>
  removedBefore(t: number, src: Source): void
  reset(): void
  meta(cov: Coverage | null, generation: string | null): void
}

/**
 * `engine` identifies the engine build (its content-hashed WebAssembly URL).
 * Rows are stored as that engine re-exports them, so a copy written by another
 * build may lack fields the current one reads: such a copy is discarded, and
 * the window is fetched afresh (D-102).
 */
export async function openPersistence(engine: string): Promise<Persistence | null> {
  let db: IDBDatabase
  try {
    db = await open()
  } catch {
    return null
  }
  // Another tab upgrades or deletes the database (Settings → Reset): let it,
  // and carry on without a copy (every later write is skipped).
  let closed = false
  db.onversionchange = () => {
    closed = true
    db.close()
  }
  const empty: Persisted = { chunks: [], cov: null, generation: null }
  const stored = new Map<number, number>() // hour -> highest delta seq
  const restored = await new Promise<Persisted>((resolve) => {
    const tx = db.transaction(['chunks', 'deltas', 'meta'], 'readonly')
    const chunkKeys = tx.objectStore('chunks').getAllKeys()
    const chunks = tx.objectStore('chunks').getAll()
    const deltaKeys = tx.objectStore('deltas').getAllKeys()
    const deltas = tx.objectStore('deltas').getAll()
    const meta = tx.objectStore('meta').get('state')
    tx.oncomplete = async () => {
      const m = meta.result as { cov: Coverage | null; generation: string | null; engine?: string } | undefined
      if (!m) return resolve(empty)
      if (m.engine !== engine) {
        // Written by another engine build: drop it all, so no old chunk is read again later.
        const w = db.transaction(['chunks', 'deltas', 'meta'], 'readwrite')
        for (const store of ['chunks', 'deltas', 'meta']) w.objectStore(store).clear()
        w.oncomplete = w.onerror = w.onabort = () => resolve(empty)
        return
      }
      for (const h of chunkKeys.result as number[]) stored.set(h, 0)
      for (const [h, seq] of deltaKeys.result as [number, number][]) stored.set(h, Math.max(stored.get(h) ?? 0, seq))
      resolve({ chunks: [...(chunks.result as Blob[]), ...(deltas.result as Blob[])], cov: m.cov, generation: m.generation })
    }
    tx.onerror = tx.onabort = () => resolve(empty)
  })
  const writer = new HourWriter()
  let generation = restored.generation // as last given to meta()
  // A row write failed (quota exceeded, say): the stored rows no longer match
  // what the coverage record would claim, so it claims nothing from now on and
  // the next load fetches its window afresh.
  let lost = false
  const putMeta = (cov: Coverage | null) => {
    const tx = db.transaction('meta', 'readwrite')
    tx.objectStore('meta').put({ cov: lost ? null : cov, generation, engine }, 'state')
    return tx
  }
  // Writes run one after another; failures are ignored (the store is a cache).
  let chain = Promise.resolve()
  const run = (fn: () => Promise<IDBTransaction | null>, onFail?: () => Promise<void>) => {
    chain = chain
      .then(async () => {
        if (closed) return
        const tx = await fn()
        if (tx) await done(tx)
      })
      .catch(async () => {
        if (closed || !onFail) return
        try {
          await onFail()
        } catch {
          /* nothing more to do */
        }
      })
    return chain
  }
  const rowsLost = async () => {
    if (lost) return
    lost = true
    await done(putMeta(null))
  }
  // The export happens now (it must see the engine as planned); only the compression waits.
  const apply = (writes: Write[], before?: number) =>
    run(async () => {
      if (!writes.length && before === undefined) return null
      // Compress first: a transaction must not wait on other promises.
      const blobs = await Promise.all(writes.map(async (w) => (w.text === '[]' ? null : await gzip(w.text))))
      const tx = db.transaction(['chunks', 'deltas'], 'readwrite')
      const chunks = tx.objectStore('chunks'), deltas = tx.objectStore('deltas')
      if (before !== undefined) {
        chunks.delete(IDBKeyRange.upperBound(before, true))
        deltas.delete(IDBKeyRange.upperBound([before], true))
      }
      writes.forEach((w, k) => {
        const b = blobs[k]
        if (!w.full) return b && deltas.put(b, [w.hour, w.seq])
        deltas.delete(deltasOf(w.hour))
        if (b) chunks.put(b, w.hour)
        else chunks.delete(w.hour)
      })
      return tx
    }, rowsLost)
  return {
    restored,
    attach: (src) => {
      writer.restore(stored, src)
      void apply(writer.plan([], src))
    },
    flush: (src) => apply(writer.plan(src.takeDirty(), src)),
    removedBefore: (t, src) => void apply(writer.removedBefore(t, src), Math.floor(t / HOUR_MS) * HOUR_MS),
    reset: () => {
      writer.reset()
      lost = false // nothing stored, so nothing missing
      void run(async () => {
        const tx = db.transaction(['chunks', 'deltas', 'meta'], 'readwrite')
        tx.objectStore('chunks').clear()
        tx.objectStore('deltas').clear()
        tx.objectStore('meta').delete('state')
        return tx
      })
    },
    meta: (cov, gen) => {
      generation = gen
      void run(async () => putMeta(cov))
    },
  }
}
