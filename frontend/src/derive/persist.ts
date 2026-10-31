// IndexedDB copy of the row store, so a reload (or an offline start) begins
// from what was already fetched. Best effort: when storage is unavailable
// the app works the same, only without the head start.
import type { ObsRow } from '../api/types'
import type { Coverage, StoreSink } from './rowStore'
import { debounce } from './debounce'

const DB = 'meshmap-derive'
const VERSION = 1

export interface Persisted {
  rows: ObsRow[]
  cov: Coverage | null
  generation: string | null
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('rows', { keyPath: 'i' }).createIndex('t', 't')
      db.createObjectStore('meta')
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

export async function openPersistence(): Promise<{ restored: Persisted; sink: StoreSink } | null> {
  let db: IDBDatabase
  try {
    db = await open()
  } catch {
    return null
  }
  const restored = await new Promise<Persisted>((resolve) => {
    const tx = db.transaction(['rows', 'meta'], 'readonly')
    const rows = tx.objectStore('rows').getAll()
    const meta = tx.objectStore('meta').get('state')
    tx.oncomplete = () => {
      const m = meta.result as { cov: Coverage | null; generation: string | null } | undefined
      resolve(m ? { rows: rows.result as ObsRow[], cov: m.cov, generation: m.generation } : { rows: [], cov: null, generation: null })
    }
    tx.onerror = () => resolve({ rows: [], cov: null, generation: null })
  })
  // Writes run one after another; failures are ignored (the store is a cache).
  let chain = Promise.resolve()
  const run = (fn: () => IDBTransaction) => {
    chain = chain.then(() => done(fn())).catch(() => {})
  }
  // Added rows are batched: live rows arrive several times a second, and one
  // transaction per batch would keep the database busy for nothing.
  let pending: ObsRow[] = []
  const flush = () => {
    if (!pending.length) return
    const rows = pending
    pending = []
    run(() => {
      const tx = db.transaction('rows', 'readwrite')
      const s = tx.objectStore('rows')
      for (const r of rows) s.put(r)
      return tx
    })
  }
  const flushSoon = debounce(flush, 2000, 5000)
  const sink: StoreSink = {
    added: (rows) => {
      pending = pending.concat(rows)
      // A large batch is a fetch, not the live stream: write it right away.
      if (pending.length > 1000) flush()
      else flushSoon()
    },
    removedBefore: (t) => {
      flush()
      run(() => {
        const tx = db.transaction('rows', 'readwrite')
        const cur = tx.objectStore('rows').index('t').openCursor(IDBKeyRange.upperBound(t, true))
        cur.onsuccess = () => {
          if (!cur.result) return
          cur.result.delete()
          cur.result.continue()
        }
        return tx
      })
    },
    reset: () => {
      pending = []
      run(() => {
        const tx = db.transaction(['rows', 'meta'], 'readwrite')
        tx.objectStore('rows').clear()
        tx.objectStore('meta').delete('state')
        return tx
      })
    },
    meta: (cov, generation) => {
      flush() // rows before the coverage mark that describes them
      run(() => {
        const tx = db.transaction('meta', 'readwrite')
        tx.objectStore('meta').put({ cov, generation }, 'state')
        return tx
      })
    },
  }
  return { restored, sink }
}
