import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MapView from './map/MapView'
import { setPingPositions } from './map/pings'
import { LiveIndicator, PeriodPanel } from './timeline/Timeline'
import { usePwa } from './pwa'
import { EdgePanel } from './features/EdgePanel'
import { NodeList } from './features/NodeList'
import { NodePanel } from './features/node/NodePanel'
import { activeFilters, FilterPanel, LayersPanel, Legend } from './features/controls'
import { SettingsPanel } from './features/menu'
import { HealthPanel } from './features/health'
import { Dock, Rail, type PanelId } from './features/rail'
import { TrendsPanel } from './features/trends'
import { useCapabilities, useHealth, useRetention, useSnapshot } from './state/data'
import type { Counts } from './derive/views'
import { useLiveStream } from './state/live'
import { initDerive } from './derive/client'
import { toQuery, useStore } from './state/store'
import { applyTheme, useTheme } from './theme'

export default function App() {
  const caps = useCapabilities()
  const retention = useRetention()
  const snap = useSnapshot()
  const health = useHealth()
  const serious = (health.data?.issues ?? []).filter((i) => i.severity !== 'notice').length
  const win = useStore((s) => s.win)
  const filters = useStore((s) => s.filters)
  const selection = useStore((s) => s.selection)
  const { online, servedOffline, canInstall, install } = usePwa()
  const [notice, setNotice] = useState<string | null>(null)
  const geo = useRef<Map<string, [number, number]>>(new Map())
  const theme = useTheme()
  useEffect(() => applyTheme(theme), [theme])
  const onPositions = useCallback((pos: Map<string, [number, number]>) => {
    geo.current = pos
    setPingPositions(pos) // pings follow the markers as estimates move
  }, [])
  const liveOK = useLiveStream(geo, setNotice)

  // The derivation worker applies the operator's geolocation settings.
  useEffect(() => {
    if (caps.data) initDerive(caps.data)
  }, [caps.data])

  // The floating header's height, for the map controls and banners below it.
  const topbar = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = topbar.current
    if (!el) return
    const set = () => (el.closest('.app') as HTMLElement | null)?.style.setProperty('--head-h', `${el.offsetHeight}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  }, [caps.data]) // the header exists once the app has loaded

  // State -> URL (shareable links). The URL seeds the store before the first
  // render (state/store.ts); entries are replaced, not pushed: back leaves the map.
  useEffect(() => {
    if (caps.data) useStore.getState().applyLimits(caps.data.default_window_hours, caps.data.max_window_hours)
  }, [caps.data])
  useEffect(() => {
    const q = toQuery({ win, filters, selection }).toString()
    const url = q ? `?${q}` : window.location.pathname
    if (url !== window.location.search) window.history.replaceState(null, '', url)
  }, [win, filters, selection])

  // One panel at a time, beside the tool rail; all start closed. Selecting a
  // node or link opens Details; if the selection opened it, clearing the
  // selection closes it again (D-066).
  const [panel, setPanel] = useState<PanelId | null>(null)
  const autoOpened = useRef(false)
  useEffect(() => {
    if (selection) {
      setPanel((p) => {
        if (p !== 'details') autoOpened.current = p === null
        return 'details'
      })
    } else if (autoOpened.current) {
      autoOpened.current = false
      setPanel((p) => (p === 'details' ? null : p))
    }
  }, [selection])
  // Closing Details (its button, ×, Escape) keeps the selection on the map:
  // on a phone it is how to see the map again without losing what was picked.
  // Clicking empty map clears it; clicking it again, or Details, reopens it.
  const closePanel = () => {
    autoOpened.current = false
    setPanel(null)
  }
  const togglePanel = (p: PanelId) => {
    if (p === panel) return closePanel()
    autoOpened.current = false
    setPanel(p)
  }
  // Closing the Nodes panel clears its search (and the dimming it causes);
  // a node picked from it opens Details and keeps the search for going back.
  useEffect(() => {
    if (panel !== 'nodes' && panel !== 'details' && useStore.getState().search) useStore.getState().setSearch('')
  }, [panel])
  // Escape closes the panel, except while typing in a field.
  useEffect(() => {
    if (!panel) return
    const esc = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      // Escape in a text field (search, dates) is the field's own: it clears or leaves it, not the panel.
      const typing = t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && ['text', 'search', 'datetime-local', 'date', 'time', 'number'].includes(t.type))
      if (e.key === 'Escape' && !typing) closePanel()
    }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [panel])

  // Fixed windows that fall out of retention while open: notify and clamp.
  useEffect(() => {
    if (win.live || !win.start || !retention.data) return
    if (Date.parse(win.start) < Date.parse(retention.data.configured_cutoff)) {
      setNotice('The selected window now starts before the retention limit; it was moved to the oldest available time.')
      const dur = Date.parse(win.end!) - Date.parse(win.start)
      const s = Date.parse(retention.data.configured_cutoff) + 60_000
      useStore.getState().setFixed(new Date(s).toISOString(), new Date(s + dur).toISOString())
    }
  }, [retention.data, win])

  // A selected link is the node pair; either direction may be missing.
  const edges = snap.data?.edges
  const linkSel = useMemo(
    () => (selection?.kind === 'edge' && (edges ?? []).some((e) => !!e.mqtt === !!selection.mqtt && ((e.src === selection.src && e.dst === selection.dst) || (e.src === selection.dst && e.dst === selection.src))) ? selection : undefined),
    [selection, edges],
  )

  if (caps.isLoading) return <div className="boot">Loading…</div>
  if (caps.error || !caps.data) return <div className="boot error">Backend unavailable: {String(caps.error)}</div>

  const sel = selection
  const counts = snap.data?.counts
  const empty = snap.data && counts && counts.packets === 0 && (snap.data.nodes ?? []).length === 0

  return (
    <div className="app">
      <main className={`main${panel ? '' : ' panel-closed'}`}>
        {/* The header floats over the map as an island too (D-082). */}
        <header id="topbar" className="topbar" ref={topbar}>
          <div className="topbar-row">
            <h1 className="brand" aria-label="868.no Map">
              <span className="brand-num">868</span><span className="brand-tld">.no</span> <span className="brand-map">Map</span>
            </h1>
            <LiveIndicator caps={caps.data} retention={retention.data} snapshot={snap.data} liveOK={liveOK} onOpen={() => togglePanel('period')} />
            {snap.isFetching && <span className="spinner" aria-label="Updating" />}
          </div>
          <Counters counts={counts} />
        </header>
        <MapView caps={caps.data} snapshot={snap.data} onPositions={onPositions} />
        <Dock open={panel} onClose={closePanel}>
          {panel === 'nodes' && <NodeList snapshot={snap.data} />}
          {panel === 'details' && (sel?.kind === 'node' ? <NodePanel id={sel.id} snapshot={snap.data} /> : linkSel ? <EdgePanel a={linkSel.src} b={linkSel.dst} mqtt={!!linkSel.mqtt} snapshot={snap.data} /> : <div className="panel muted">Select a node or link on the map, or find one under Nodes.</div>)}
          {panel === 'health' && <HealthPanel snapshot={snap.data} />}
          {panel === 'trends' && <TrendsPanel />}
          {panel === 'period' && <PeriodPanel caps={caps.data} retention={retention.data} snapshot={snap.data} />}
          {panel === 'filters' && <FilterPanel snapshot={snap.data} />}
          {panel === 'layers' && <LayersPanel />}
          {panel === 'legend' && <Legend snapshot={snap.data} />}
          {panel === 'settings' && <SettingsPanel canInstall={canInstall} install={install} />}
        </Dock>
        <Rail open={panel} onToggle={togglePanel} badges={{ filters: activeFilters(filters), health: serious }} />
        <div className="banners">
          {(!online || servedOffline) && (
            <div className="banner hist" role="status">
              Offline: showing the data last received{snap.data ? ` (up to ${new Date(snap.data.meta.data_until).toLocaleString()})` : ''}. Live updates resume when the connection returns.
            </div>
          )}
          {snap.error && <div className="banner error">{String((snap.error as Error).message)}</div>}
          {!snap.data && snap.isLoading && <div className="banner">Loading window…</div>}
          {empty && <div className="banner">No observed data for this interval.</div>}
          {counts?.nodes_truncated && <div className="banner">Large network: showing the most active nodes.</div>}
          {snap.data?.edges_truncated && <div className="banner">Showing the best-supported links only.</div>}
          {notice && <div className="banner" role="status" onClick={() => setNotice(null)}>{notice} (click to dismiss)</div>}
        </div>
      </main>
    </div>
  )
}

// Header counters. Until the first snapshot arrives, each number is a
// placeholder bar about as wide as a typical value, so the header keeps
// roughly its final size instead of growing when the counts load.
const COUNTERS: ['packets' | 'receptions' | 'nodes' | 'referenced' | 'positioned' | 'estimated' | 'edges', string, number, string][] = [
  ['nodes', ' heard · ', 3, 'Nodes heard in the window: they sent something, or uplinked as a gateway'],
  ['referenced', ' only named · ', 3, 'Further nodes never heard themselves, only named in others\' NeighborInfo or traceroutes'],
  ['positioned', ' positioned · ', 3, 'Nodes with a position they reported in the window (of all nodes above)'],
  ['estimated', ' estimated · ', 2, 'Nodes without a reported position whose location is estimated from who hears them'],
  ['edges', ' links · ', 4, 'Radio links between node pairs (one per pair, as drawn), whatever the map\'s link filters show'],
  ['packets', ' packets / ', 4, 'Distinct packets in the window'],
  ['receptions', ' receptions', 5, 'Gateway receptions of those packets: one per gateway and copy'],
]
function Counters({ counts }: { counts?: Counts }) {
  return (
    <span className="counters" aria-busy={!counts}>
      {COUNTERS.map(([k, label, digits, title]) => (
        <span key={k} title={title}>
          {counts ? counts[k] : <span className="counter-ph" style={{ width: `${digits}ch` }} aria-hidden />}
          {label}
        </span>
      ))}
    </span>
  )
}
