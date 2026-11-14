// Beta mode (D-215): early features, shown only to a viewer who turns it on
// with the Konami code. Kept in this browser only, like the watchlist.
import { useEffect } from 'react'
import { create } from 'zustand'

const KEY = 'meshmap.beta'

export const KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'] as const

function load(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1'
  } catch {
    return false // storage unavailable: off
  }
}

interface Beta {
  on: boolean
  toggle: () => boolean
}

// Export it again for the next beta feature to read `on` (D-215).
const useBeta = create<Beta>((set, get) => ({
  on: load(),
  toggle: () => {
    const on = !get().on
    set({ on })
    try {
      if (on) window.localStorage.setItem(KEY, '1')
      else window.localStorage.removeItem(KEY)
    } catch {
      /* this page only */
    }
    return on
  },
}))

/**
 * How far into the Konami code `progress` keys are after `key`: the code's
 * length when it is complete. A wrong key restarts it, counting itself when
 * it is the code's first.
 */
export function konamiStep(progress: number, key: string): number {
  const k = key.toLowerCase()
  if (k === KONAMI[progress]) return progress + 1
  // ↑ ↑ ↑ keeps two: the code may start one key late.
  if (progress === 2 && k === 'arrowup') return 2
  return k === KONAMI[0] ? 1 : 0
}

/** Toggles beta mode on the Konami code, outside text fields; `onToggle` is told the new state. */
export function useKonami(onToggle: (on: boolean) => void) {
  useEffect(() => {
    let progress = 0
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return
      progress = konamiStep(progress, e.key)
      if (progress === KONAMI.length) {
        progress = 0
        onToggle(useBeta.getState().toggle())
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onToggle])
}
