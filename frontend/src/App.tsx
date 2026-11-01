import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MapView from './map/MapView'
import { setPingPositions } from './map/pings'
import Timeline from './timeline/Timeline'
import { usePwa } from './pwa'
import { EdgePanel, NodeList, NodePanel } from './features/panels'
import { FilterPanel, LayersPanel, Legend } from './features/controls'
import { AppMenu } from './features/menu'
import { useCapabilities, useRetention, useSnapshot, useTraffic } from './state/data'
import { useLiveStream } from './state/live'
import { initDerive } from './derive/client'
import { fromQuery, toQuery, useStore } from './state/store'
import { applyTheme, useTheme } from './theme'

type Tab = 'nodes' | 'details' | 'filters' | 'legend'

export default function App() {
  const caps = useCapabilities()
  const retention = useRetention()
  const snap = useSnapshot()
  const traffic = useTraffic()
  const win = useStore((s) => s.win)
  const filters = useStore((s) => s.filters)
  const selection = useStore((s) => s.selection)
  const [tab, setTab] = useState<Tab>('nodes')
  const { online, servedOffline, canInstall, install } = usePwa()
  const [notice, setNotice] = useState<string | null>(null)
  const geo = useRef<Map<string, [number, number]>>(new Map())
  const theme = useTheme()
  useEffect(() => applyTheme(theme), [theme])
  // One top-bar popover at a time; Escape or a click elsewhere closes it.
  const [popover, setPopover] = useState<'layers' | 'menu' | null>(null)
  const actions = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!popover) return
    const away = (e: Event) => {
      if (!actions.current?.contains(e.target as Node)) setPopover(null)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPopover(null)
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [popover])
  const toggleOpen = (p: 'layers' | 'menu') => setPopover((o) => (o === p ? null : p))
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

  // The sidebar starts hidden. Selecting a node or link opens it on Details;
  // if the selection opened it, clearing the selection hides it again.
  const [panelOpen, setPanelOpen] = useState(false)
  const autoOpened = useRef(false)
  useEffect(() => {
    if (selection) {
      setTab('details')
      setPanelOpen((open) => {
        if (!open) autoOpened.current = true
        return true
      })
    } else if (autoOpened.current) {
      autoOpened.current = false
      setPanelOpen(false)
    }
  }, [selection])
  const togglePanel = () => {
    autoOpened.current = false
    setPanelOpen((o) => !o)
  }

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
        <div className="topbar-actions" ref={actions}>
          <button aria-expanded={popover === 'layers'} aria-controls="layers-panel" aria-label="Layers" onClick={() => toggleOpen('layers')} title="Choose what the map shows">
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d="M10 3 2.5 7 10 11l7.5-4L10 3Z" /><path d="m2.5 10.5 7.5 4 7.5-4" /><path d="m2.5 14 7.5 4 7.5-4" /></svg>
            <span className="btn-label">Layers</span>
          </button>
          <button className="panel-toggle" aria-expanded={panelOpen} aria-controls="sidebar" aria-label={panelOpen ? 'Hide panel' : 'Nodes & details'} onClick={togglePanel} title={panelOpen ? 'Hide the side panel' : 'Show nodes, details, filters and legend'}>
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="M12.5 3.5v13" /></svg>
            <span className="btn-label">{panelOpen ? 'Hide panel' : 'Nodes & details'}</span>
          </button>
          <button className="icon-btn" aria-expanded={popover === 'menu'} aria-controls="app-menu" aria-label="Menu" onClick={() => toggleOpen('menu')} title="Theme, install, source code, license and privacy">
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" /></svg>
          </button>
          {popover === 'layers' && <LayersPanel id="layers-panel" onClose={() => setPopover(null)} />}
          {popover === 'menu' && <AppMenu id="app-menu" onClose={() => setPopover(null)} canInstall={canInstall} install={install} />}
        </div>
      </header>
      <main className={`main${panelOpen ? '' : ' panel-closed'}`}>
        <MapView caps={caps.data} snapshot={snap.data} onPositions={onPositions} />
        <aside id="sidebar" className="sidebar" aria-label="Details" hidden={!panelOpen}>
          <nav className="tabs" role="tablist">
            {(['nodes', 'details', 'filters', 'legend'] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === 'nodes' && <NodeList snapshot={snap.data} />}
            {tab === 'details' && (sel?.kind === 'node' ? <NodePanel id={sel.id} snapshot={snap.data} /> : linkSel ? <EdgePanel a={linkSel.src} b={linkSel.dst} mqtt={!!linkSel.mqtt} snapshot={snap.data} /> : <div className="panel muted">Select a node or link on the map or in the list.</div>)}
            {tab === 'filters' && <FilterPanel snapshot={snap.data} />}
            {tab === 'legend' && <Legend snapshot={snap.data} />}
          </div>
        </aside>
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
