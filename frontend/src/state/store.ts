import { create } from 'zustand'
import { defaultBasemap, type BasemapGroup } from '../map/layers'
import type { ThemeChoice } from '../theme'

export type Confidence = 'low' | 'medium' | 'high'

export interface Filters {
  channels: string[]
  brokers: string[]
  types: string[]
  evidence: string[] // client-side edge filter
  minConfidence: Confidence
  positionedOnly: boolean
}

export interface Toggles {
  infraLinks: boolean // both ends ROUTER / ROUTER_LATE
  otherLinks: boolean // at least one end has another role
  inferred: boolean
  uncertainty: boolean
  animation: boolean
  labels: boolean
  theme: ThemeChoice
  basemap: Record<BasemapGroup, boolean>
}

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; src: string; dst: string } | null

export interface WindowState {
  live: boolean
  durationH: number // rolling window length
  start: string | null // fixed window (UTC ISO)
  end: string | null
}

interface Store {
  win: WindowState
  filters: Filters
  toggles: Toggles
  selection: Selection
  route: string | null // logical key of the packet whose route is drawn
  search: string
  setLive: (durationH?: number) => void
  setFixed: (start: string, end: string) => void
  setFilters: (f: Partial<Filters>) => void
  setToggles: (t: Partial<Omit<Toggles, 'basemap'>> & { basemap?: Partial<Toggles['basemap']> }) => void
  select: (s: Selection) => void
  showRoute: (lp: string | null) => void
  setSearch: (s: string) => void
}

export const defaultFilters: Filters = { channels: [], brokers: [], types: [], evidence: [], minConfidence: 'low', positionedOnly: false }
const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export const defaultToggles: Toggles = { infraLinks: false, otherLinks: false, inferred: true, uncertainty: false, animation: !prefersReducedMotion, labels: true, theme: 'system', basemap: defaultBasemap }

// Layer choices are a per-viewer convenience kept in browser storage; the
// map works the same when storage is unavailable.
// public/theme-boot.js reads the theme from this key too.
export const TOGGLES_KEY = 'meshmap:toggles:v5' // bumped when defaults change (v2 node names on, v3 major roads off, v4 accuracy circles off, v5 links off)
function loadToggles(): Toggles {
  try {
    const saved = JSON.parse(window.localStorage.getItem(TOGGLES_KEY) ?? 'null') as Partial<Toggles> | null
    if (saved && typeof saved === 'object') return { ...defaultToggles, ...saved, basemap: { ...defaultBasemap, ...(saved.basemap ?? {}) } }
  } catch {
    /* storage blocked or corrupt */
  }
  return defaultToggles
}
function saveToggles(t: Toggles) {
  try {
    window.localStorage.setItem(TOGGLES_KEY, JSON.stringify(t))
  } catch {
    /* storage blocked */
  }
}

export const useStore = create<Store>((set) => ({
  win: { live: true, durationH: 72, start: null, end: null },
  filters: defaultFilters,
  toggles: typeof window === 'undefined' ? defaultToggles : loadToggles(),
  selection: null,
  route: null,
  search: '',
  setLive: (durationH) =>
    set((s) => ({ win: { live: true, durationH: durationH ?? s.win.durationH, start: null, end: null } })),
  // A fixed window never creeps forward.
  setFixed: (start, end) => set((s) => ({ win: { ...s.win, live: false, start, end } })),
  setFilters: (f) => set((s) => ({ filters: { ...s.filters, ...f } })),
  setToggles: (t) =>
    set((s) => {
      const toggles = { ...s.toggles, ...t, basemap: { ...s.toggles.basemap, ...(t.basemap ?? {}) } }
      saveToggles(toggles)
      return { toggles }
    }),
  // A drawn packet route belongs to the selected node: any new selection clears it.
  select: (selection) => set({ selection, route: null }),
  showRoute: (route) => set({ route }),
  setSearch: (search) => set({ search }),
}))

// ---- URL sync: the window and filters are shareable links ----

export function toQuery(s: Pick<Store, 'win' | 'filters'>): URLSearchParams {
  const q = new URLSearchParams()
  if (s.win.live) {
    if (s.win.durationH !== 72) q.set('duration', `${s.win.durationH}h`)
  } else if (s.win.start && s.win.end) {
    q.set('start', s.win.start)
    q.set('end', s.win.end)
  }
  if (s.filters.channels.length) q.set('channel', s.filters.channels.join(','))
  if (s.filters.brokers.length) q.set('broker', s.filters.brokers.join(','))
  if (s.filters.types.length) q.set('type', s.filters.types.join(','))
  return q
}

export function fromQuery(q: URLSearchParams): Partial<Pick<Store, 'win' | 'filters'>> {
  const out: Partial<Pick<Store, 'win' | 'filters'>> = {}
  const start = q.get('start'), end = q.get('end'), dur = q.get('duration')
  if (start && end && !Number.isNaN(Date.parse(start)) && !Number.isNaN(Date.parse(end))) {
    out.win = { live: false, durationH: 72, start, end }
  } else if (dur) {
    const h = parseInt(dur, 10)
    if (h >= 1 && h <= 168) out.win = { live: true, durationH: h, start: null, end: null }
  }
  const list = (k: string) => (q.get(k) ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  out.filters = { ...defaultFilters, channels: list('channel'), brokers: list('broker'), types: list('type') }
  return out
}

/** API query parameters for the current state (window + server-side filters). */
export function apiParams(s: Pick<Store, 'win' | 'filters'>, extra?: Record<string, string>): URLSearchParams {
  const q = new URLSearchParams()
  if (s.win.live) q.set('duration', `${s.win.durationH}h`)
  else if (s.win.start && s.win.end) {
    q.set('start', s.win.start)
    q.set('end', s.win.end)
  }
  if (s.filters.channels.length) q.set('channel', s.filters.channels.join(','))
  if (s.filters.brokers.length) q.set('broker', s.filters.brokers.join(','))
  if (s.filters.types.length) q.set('type', s.filters.types.join(','))
  for (const [k, v] of Object.entries(extra ?? {})) q.set(k, v)
  return q
}
