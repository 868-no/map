// Offline support and installation. The service worker (sw/sw.js) serves the
// app shell offline and the last API responses; this module registers it,
// tracks whether data on screen came from that saved copy, and exposes the
// browser's install prompt where one exists.
import { create } from 'zustand'

interface PwaState {
  online: boolean
  servedOffline: boolean // the map's views are built from the saved copy (the banner says so)
  apiOffline: boolean // the latest other API response (capabilities, weather, ...) came from the service worker's cache
  canInstall: boolean
  install: () => Promise<void>
}

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
let deferred: InstallPrompt | null = null

export const usePwa = create<PwaState>((set) => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  servedOffline: false,
  apiOffline: false,
  canInstall: false,
  install: async () => {
    if (!deferred) return
    await deferred.prompt()
    await deferred.userChoice
    deferred = null
    set({ canInstall: false })
  },
}))

/** Called for every API response other than the views' own (the worker reports those). */
export function noteResponse(res: Response): void {
  const offline = res.headers.get('x-meshmap-offline') === '1'
  if (usePwa.getState().apiOffline !== offline) usePwa.setState({ apiOffline: offline })
}

export function setupPwa(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('online', () => usePwa.setState({ online: true }))
  window.addEventListener('offline', () => usePwa.setState({ online: false }))
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // offer our own button instead of the mini-infobar
    deferred = e as InstallPrompt
    usePwa.setState({ canInstall: true })
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    usePwa.setState({ canInstall: false })
  })
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker registration failed', e))
    })
  }
}
