import { create } from 'zustand'
import { defaultBasemap, type BasemapGroup } from '../map/layers'
import type { ThemeChoice } from '../theme'

export type Confidence = 'low' | 'medium' | 'high'

/** Tabs of the node Details panel (D-098). */
export type DetailTab = 'overview' | 'links' | 'radio' | 'telemetry' | 'packets'

export interface Filters {
  channels: string[]
  brokers: string[]
  types: string[]
  evidence: string[] // client-side edge filter
  minConfidence: Confidence
  positionedOnly: boolean
  onlineOnly: boolean // only nodes heard within 3 h of the window's end (D-101)
}

export interface Toggles {
  infraLinks: boolean // both ends ROUTER / ROUTER_LATE
  otherLinks: boolean // at least one end has another role
  mqttLinks: boolean // hops that went over MQTT, not radio (D-055)
  inferred: boolean
  uncertainty: boolean
  animation: boolean
  labels: boolean
  regions: boolean // Norway's landsdeler beneath the mesh
  trails: boolean // tracks behind moving nodes (D-073)
  theme: ThemeChoice
  basemap: Record<BasemapGroup, boolean>
}

/** Reach simulation settings: the hop limit to show, and whether internet links count. */
export interface Reach {
  hops: number
  internet: boolean
}

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; src: string; dst: string; mqtt?: boolean } | null

export interface WindowState {
  live: boolean
  durationH: number // rolling window length
  start: string | null // fixed window (UTC ISO)
  end: string | null
}

/**
 * The server's window limits (`/capabilities`): the default rolling window
 * and the longest window it serves. Until they arrive these are the server's
 * own defaults, but no view is requested before then (`limitsReady`).
 */
export const windowLimits = { defaultH: 72, maxH: 168 }

interface Store {
  win: WindowState
  /** The server's window limits are applied to `win`: views may be requested. */
  limitsReady: boolean
  applyLimits: (defaultH: number, maxH: number) => void
  filters: Filters
  toggles: Toggles
  selection: Selection
  route: string | null // logical key of the packet whose route is drawn
  reach: Reach | null // the selected node's simulated reach, drawn on the map (D-069)
  search: string
  detailTab: DetailTab // the node panel's tab, kept across selections
  setLive: (durationH?: number) => void
  setFixed: (start: string, end: string) => void
  setFilters: (f: Partial<Filters>) => void
  setToggles: (t: Partial<Omit<Toggles, 'basemap'>> & { basemap?: Partial<Toggles['basemap']> }) => void
  select: (s: Selection) => void
  showRoute: (lp: string | null) => void
  setReach: (r: Reach | null) => void
  setSearch: (s: string) => void
  setDetailTab: (t: DetailTab) => void
}

export const defaultFilters: Filters = { channels: [], brokers: [], types: [], evidence: [], minConfidence: 'low', positionedOnly: false, onlineOnly: false }
const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export const defaultToggles: Toggles = { infraLinks: false, otherLinks: false, mqttLinks: false, inferred: true, uncertainty: false, animation: !prefersReducedMotion, labels: true, regions: false, trails: false, theme: 'system', basemap: defaultBasemap }

// Layer choices are a per-viewer convenience kept in browser storage; the
// map works the same when storage is unavailable.
// public/theme-boot.js reads the theme from this key too.
export const TOGGLES_KEY = 'meshmap:toggles:v6' // bumped when defaults change (v2 node names on, v3 major roads off, v4 accuracy circles off, v5 links off, v6 roads and city names on)
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
  limitsReady: false,
  applyLimits: (defaultH, maxH) =>
    set((s) => {
      windowLimits.defaultH = defaultH
      windowLimits.maxH = maxH
      const w = s.win
      // The default applies once, on the first limits: a later refetch of the
      // capabilities only clamps, never resets a length the viewer chose.
      if (w.live) return { limitsReady: true, win: { ...w, durationH: Math.min(urlDuration || s.limitsReady ? w.durationH : defaultH, maxH) } }
      // A fixed window longer than the server serves keeps its end.
      const end = Date.parse(w.end!), start = Math.max(Date.parse(w.start!), end - maxH * 3_600_000)
      return { limitsReady: true, win: { ...w, start: new Date(start).toISOString() } }
    }),
  filters: defaultFilters,
  toggles: typeof window === 'undefined' ? defaultToggles : loadToggles(),
  selection: null,
  route: null,
  reach: null,
  search: '',
  detailTab: 'overview',
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
  select: (selection) => set({ selection, route: null, reach: null }),
  showRoute: (route) => set({ route, reach: null }),
  setReach: (reach) => set({ reach, route: null }),
  setSearch: (search) => set({ search }),
  setDetailTab: (detailTab) => set({ detailTab }),
}))

// ---- URL sync: the window and filters are shareable links ----

/** A node id as the URL carries it (`!` and 8 hex digits). */
const NODE_ID = /^![0-9a-f]{8}$/

/** A link to a node that stays valid: the node alone, no window or filters (D-080). */
export function nodeLink(id: string, origin = window.location.origin): string {
  return `${origin}/?node=${id}`
}

export function toQuery(s: Pick<Store, 'win' | 'filters'> & { selection?: Selection }): URLSearchParams {
  const q = new URLSearchParams()
  if (s.selection?.kind === 'node') q.set('node', s.selection.id)
  if (s.win.live) {
    if (s.win.durationH !== windowLimits.defaultH) q.set('duration', `${s.win.durationH}h`)
  } else if (s.win.start && s.win.end) {
    q.set('start', s.win.start)
    q.set('end', s.win.end)
  }
  if (s.filters.channels.length) q.set('channel', s.filters.channels.join(','))
  if (s.filters.brokers.length) q.set('broker', s.filters.brokers.join(','))
  if (s.filters.types.length) q.set('type', s.filters.types.join(','))
  return q
}

export function fromQuery(q: URLSearchParams): Partial<Pick<Store, 'win' | 'filters' | 'selection'>> {
  const out: Partial<Pick<Store, 'win' | 'filters' | 'selection'>> = {}
  const node = q.get('node')?.toLowerCase()
  if (node && NODE_ID.test(node)) out.selection = { kind: 'node', id: node }
  const start = q.get('start'), end = q.get('end'), dur = q.get('duration')
  if (start && end && !Number.isNaN(Date.parse(start)) && !Number.isNaN(Date.parse(end))) {
    out.win = { live: false, durationH: windowLimits.defaultH, start, end }
  } else if (dur) {
    const h = parseInt(dur, 10)
    if (h >= 1 && h <= 168) out.win = { live: true, durationH: h, start: null, end: null }
  }
  const list = (k: string) => (q.get(k) ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  out.filters = { ...defaultFilters, channels: list('channel'), brokers: list('broker'), types: list('type') }
  return out
}

/**
 * API query parameters for the current state: the window, plus the channel,
 * broker and type filters. The server no longer filters (the engine does);
 * these only key the queries and the live stream URL.
 */
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

// The URL seeds the state before the first render, so a shared link never
// first loads the default window. The window it names is clamped to the
// server's limits once they are known (applyLimits); a live link without a
// duration takes the server's default.
let urlDuration = false
if (typeof window !== 'undefined') {
  const init = fromQuery(new URLSearchParams(window.location.search))
  urlDuration = !!init.win?.live
  useStore.setState(init)
}
