// Settings → Reset (D-076): forget everything this site stored in the
// browser — layer choices and theme, the IndexedDB copy of the rows, the
// service worker's caches and registration — and start over.
import { stopDerive } from './derive/client'

const ignore = async (f: () => unknown) => {
  try {
    await f()
  } catch {
    /* storage unavailable or already gone: nothing to clear */
  }
}

export async function resetEverything(): Promise<void> {
  // The worker holds the database open; deleting it would wait on the worker.
  // Stopped for good: no live row or view starts another, which would open
  // the database again (or create it anew) while it is being deleted.
  stopDerive()
  await ignore(() => localStorage.clear())
  await ignore(() => sessionStorage.clear())
  await ignore(async () => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [{ name: 'meshmap-cache' }, { name: 'meshmap-derive' }]
    await Promise.all(
      dbs.map((d) => d.name && new Promise<void>((done) => {
        const r = indexedDB.deleteDatabase(d.name!)
        r.onsuccess = r.onerror = r.onblocked = () => done()
      })),
    )
  })
  await ignore(async () => Promise.all((await caches.keys()).map((k) => caches.delete(k))))
  await ignore(async () => Promise.all((await navigator.serviceWorker.getRegistrations()).map((r) => r.unregister())))
  // Without the query string: the window and filters in the URL go too.
  location.replace(location.pathname)
}
