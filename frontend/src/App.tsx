import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MapView from './map/MapView'
import { setPingPositions } from './map/pings'
import Timeline from './timeline/Timeline'
import { usePwa } from './pwa'
import { EdgePanel, NodeList, NodePanel } from './features/panels'
import { activeFilters, FilterPanel, LayersPanel, Legend } from './features/controls'
import { SettingsPanel } from './features/menu'
import { Dock, Rail, type PanelId } from './features/rail'
import { useCapabilities, useRetention, useSnapshot, useTraffic } from './state/data'
import { useLiveStream } from './state/live'
import { initDerive } from './derive/client'
import { fromQuery, toQuery, useStore } from './state/store'
import { applyTheme, useTheme } from './theme'

export default function App() {
  const caps = useCapabilities()
  const retention = useRetention()
  const snap = useSnapshot()
  const traffic = useTraffic()
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

  // URL <-> state (shareable links; back/forward).
  useEffect(() => {
    const init = fromQuery(new URLSearchParams(window.location.search))
    useStore.setState((s) => ({ ...s, ...init }))
  }, [])
  useEffect(() => {
    const q = toQuery({ win, filters }).toString()
    const url = q ? `?${q}` : window.location.pathname
    if (url !== window.location.search) window.history.replaceState(null, '', url)
  }, [win, filters])

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
  // Details shows the selection: closing it (its button, ×, Escape) clears it.
  const closePanel = () => {
    autoOpened.current = false
    if (panel === 'details' && useStore.getState().selection) useStore.getState().select(null)
    setPanel(null)
  }
  const togglePanel = (p: PanelId) => {
    if (p === panel) return closePanel()
    autoOpened.current = false
    setPanel(p)
  }
  // Escape closes the panel, except while typing in a field.
  useEffect(() => {
    if (!panel) return
    const esc = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === 'Escape' && !(t instanceof HTMLInputElement && t.type === 'text') && !(t instanceof HTMLTextAreaElement)) closePanel()
    }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [panel]) // eslint-disable-line react-hooks/exhaustive-deps

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
      <header className="topbar">
        <h1 className="brand" aria-label="868.no Map">
          <span className="brand-num">868</span><span className="brand-tld">.no</span> <span className="brand-map">Map</span>
        </h1>
        {counts && (
          <span className="counters" aria-live="polite">
            {counts.nodes} nodes · {counts.referenced} referenced · {counts.positioned} positioned · {counts.estimated} estimated · {counts.edges} links · {counts.packets} packets / {counts.receptions} receptions
          </span>
        )}
        {snap.isFetching && <span className="spinner" aria-label="Updating" />}
      </header>
      <main className={`main${panel ? '' : ' panel-closed'}`}>
        <MapView caps={caps.data} snapshot={snap.data} onPositions={onPositions} />
        <Dock open={panel} onClose={closePanel}>
          {panel === 'nodes' && <NodeList snapshot={snap.data} />}
          {panel === 'details' && (sel?.kind === 'node' ? <NodePanel id={sel.id} snapshot={snap.data} /> : linkSel ? <EdgePanel a={linkSel.src} b={linkSel.dst} mqtt={!!linkSel.mqtt} snapshot={snap.data} /> : <div className="panel muted">Select a node or link on the map, or find one under Nodes.</div>)}
          {panel === 'filters' && <FilterPanel snapshot={snap.data} />}
          {panel === 'layers' && <LayersPanel />}
          {panel === 'legend' && <Legend snapshot={snap.data} />}
          {panel === 'settings' && <SettingsPanel canInstall={canInstall} install={install} />}
        </Dock>
        <Rail open={panel} onToggle={togglePanel} badges={{ filters: activeFilters(filters) }} />
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
      <Timeline caps={caps.data} retention={retention.data} snapshot={snap.data} traffic={traffic.data} liveOK={liveOK} />
    </div>
  )
}
