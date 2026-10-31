// IndexedDB copy of the engine's rows, so a reload (or an offline start)
// begins from what was already fetched. Rows are stored per hour as gzip-
// compressed JSON (the API's row format): only hours that changed are
// rewritten. Best effort: without storage the app works the same, only
// without the head start.
import type { Coverage } from './rowStore'

const DB = 'meshmap-derive'
const VERSION = 2 // 2: hourly compressed chunks (1 stored one record per row)
export const HOUR_MS = 3_600_000

export interface Persisted {
  chunks: string[] // JSON arrays of rows
  cov: Coverage | null
  generation: string | null
}

/** What persistence needs from the engine. */
export interface Source {
  takeDirty(): number[] // hour starts with new rows
  exportHour(start: number): string // JSON array of the hour's rows
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (db.objectStoreNames.contains('rows')) db.deleteObjectStore('rows')
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks')
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      // A format change starts over: the old meta described the old rows.
      req.transaction?.objectStore('meta').clear()
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error)
  })

const gzip = (text: string) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob()
const gunzip = (b: Blob) => new Response(b.stream().pipeThrough(new DecompressionStream('gzip'))).text()

export interface Persistence {
  restored: Persisted
  /** Write the hours that changed (call after rows were added). */
  flush(src: Source): Promise<void>
  removedBefore(t: number, src: Source): void
  reset(): void
  meta(cov: Coverage | null, generation: string | null): void
}

export async function openPersistence(): Promise<Persistence | null> {
  let db: IDBDatabase
  try {
    db = await open()
  } catch {
    return null
  }
  const empty: Persisted = { chunks: [], cov: null, generation: null }
  const restored = await new Promise<Persisted>((resolve) => {
    const tx = db.transaction(['chunks', 'meta'], 'readonly')
    const chunks = tx.objectStore('chunks').getAll()
    const meta = tx.objectStore('meta').get('state')
    tx.oncomplete = async () => {
      const m = meta.result as { cov: Coverage | null; generation: string | null } | undefined
      if (!m) return resolve(empty)
      try {
        resolve({ chunks: await Promise.all((chunks.result as Blob[]).map(gunzip)), cov: m.cov, generation: m.generation })
      } catch {
        resolve(empty)
      }
    }
    tx.onerror = () => resolve(empty)
  })
  // Writes run one after another; failures are ignored (the store is a cache).
  let chain = Promise.resolve()
  const run = (fn: () => Promise<IDBTransaction | null>) => {
    chain = chain.then(async () => {
      const tx = await fn()
      if (tx) await done(tx)
    }).catch(() => {})
    return chain
  }
  const writeHours = (hours: number[], src: Source) =>
    run(async () => {
      if (!hours.length) return null
      // Compress first: a transaction must not wait on other promises.
      const blobs = await Promise.all(hours.map(async (h) => {
        const text = src.exportHour(h)
        return [h, text === '[]' ? null : await gzip(text)] as const
      }))
      const tx = db.transaction('chunks', 'readwrite')
      const s = tx.objectStore('chunks')
      for (const [h, b] of blobs) {
        if (b) s.put(b, h)
        else s.delete(h)
      }
      return tx
    })
  return {
    restored,
    flush: (src) => writeHours(src.takeDirty(), src),
    removedBefore: (t, src) => {
      const hour = Math.floor(t / HOUR_MS) * HOUR_MS
      run(async () => {
        const tx = db.transaction('chunks', 'readwrite')
        tx.objectStore('chunks').delete(IDBKeyRange.upperBound(hour, true))
        return tx
      })
      writeHours([hour], src) // the partly trimmed hour
    },
    reset: () =>
      void run(async () => {
        const tx = db.transaction(['chunks', 'meta'], 'readwrite')
        tx.objectStore('chunks').clear()
        tx.objectStore('meta').delete('state')
        return tx
      }),
    meta: (cov, generation) =>
      void run(async () => {
        const tx = db.transaction('meta', 'readwrite')
        tx.objectStore('meta').put({ cov, generation }, 'state')
        return tx
      }),
  }
}
