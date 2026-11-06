// Colour theme: the viewer picks light, dark or "system" (follow the
// browser's preference, the default). public/theme-boot.js applies the same
// rule before the app loads, so the first paint is already right.
import { useSyncExternalStore } from 'react'
import { useStore } from './state/store'

export type ThemeChoice = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const query = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: light)') : undefined
const subscribe = (cb: () => void) => {
  query?.addEventListener?.('change', cb)
  return () => query?.removeEventListener?.('change', cb)
}
const prefersLight = () => !!query?.matches

export function resolveTheme(choice: ThemeChoice, browserPrefersLight: boolean): Theme {
  return choice === 'system' ? (browserPrefersLight ? 'light' : 'dark') : choice
}

/** The theme in effect: the viewer's choice, or the browser's preference (live). */
export function useTheme(): Theme {
  const choice = useStore((s) => s.toggles.theme)
  const light = useSyncExternalStore(subscribe, prefersLight, () => false)
  return resolveTheme(choice, light)
}

/** Background per theme (matches --bg in index.css): browser UI colour. */
const THEME_BG: Record<Theme, string> = { dark: '#0e1116', light: '#f6f7f9' }

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_BG[t])
}
