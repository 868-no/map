import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { subscribeLive } from './api/client'
import MapView from './map/MapView'
import { addTransmission, clearPings, pingWanted, setPingPositions } from './map/pings'
import Timeline from './timeline/Timeline'
import { usePwa } from './pwa'
import { EdgePanel, NodeList, NodePanel } from './features/panels'
import { FilterPanel, Legend } from './features/controls'
import { useCapabilities, useLiveEpoch, useRetention, useSnapshot, useTraffic } from './state/data'
import { initDerive, onTransmissions, sendLiveRows } from './derive/client'
import { apiParams, defaultFilters, fromQuery, toQuery, useStore, type Filters } from './state/store'
import type { ObsRow } from './api/types'

/** A live row passes the view filters (the stream itself is unfiltered). */
function passes(r: ObsRow, f: Filters): boolean {
  return (!f.channels.length || (r.c != null && f.channels.includes(r.c))) && (!f.brokers.length || f.brokers.includes(r.b)) && (!f.types.length || f.types.includes(r.y))
}

type Tab = 'nodes' | 'details' | 'filters' | 'legend'

export default function App() {
  const caps = useCapabilities()
  const retention = useRetention()
  const snap = useSnapshot()
  const traffic = useTraffic()
  const qc = useQueryClient()
  const win = useStore((s) => s.win)
  const filters = useStore((s) => s.filters)
  const selection = useStore((s) => s.selection)
  const [tab, setTab] = useState<Tab>('nodes')
  const { online, servedOffline, canInstall, install } = usePwa()
  const [liveOK, setLiveOK] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const geo = useRef<Map<string, [number, number]>>(new Map())
  const onPositions = useCallback((pos: Map<string, [number, number]>) => {
    geo.current = pos
    setPingPositions(pos) // pings follow the markers as estimates move
  }, [])
  // The worker attributes live rows to transmissions; the animation places them.
  useEffect(() => onTransmissions((ts) => ts.forEach((t) => addTransmission(t, geo.current))), [])

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

  // Live updates for the rolling window only. The stream carries every new
  // row (unfiltered: the browser's copy needs them all); filters apply here.
  const bump = useLiveEpoch((s) => s.bump)
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  useEffect(() => {
    if (!win.live) return
    const params = apiParams({ win, filters: defaultFilters })
    let lastRefresh = Date.now() // the views were just loaded
    let wasLive = true
    let clockOffset = 0 // server time minus local time, from heartbeats
    const unsub = subscribeLive(params, {
      onHeartbeat: (h) => {
        clockOffset = Date.parse(h.now) - Date.now()
        // Every row arrives over the stream; this sync only fills gaps the
        // stream might have left (and slides an idle window), once a minute.
        if (Date.now() - lastRefresh > 60_000) {
          lastRefresh = Date.now()
          bump(h.window.end)
        }
      },
      onDelta: (events) => {
        const rows = events.flatMap((e) => (e.row ? [e.row] : []))
        const f = filtersRef.current
        const now = Date.now() + clockOffset
        // Pings: radio traffic only (not a node's own map report), passing the
        // filters, recent, and only while someone is watching (D-034).
        const ping = rows.flatMap((r, k) => (r.y !== 'mapreport' && passes(r, f) && pingWanted(r.t, now, document.hidden) ? [k] : []))
        sendLiveRows(rows, ping)
      },
      onStatus: (ok, reason) => {
        setLiveOK(ok)
        // Back after an interruption, or the server dropped events for us
        // (too slow): fetch whatever the stream missed.
        if (ok && (!wasLive || reason === 'lagged')) {
          lastRefresh = Date.now()
          bump(`reconnect:${Date.now()}`)
        }
        wasLive = ok
      },
      onRetention: () => {
        setNotice('Old data was removed by retention; views refreshed.')
        qc.invalidateQueries()
      },
    })
    return () => {
      unsub()
      clearPings()
    }
  }, [win, bump, qc])

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

  if (caps.isLoading) return <div className="boot">Loading…</div>
  if (caps.error || !caps.data) return <div className="boot error">Backend unavailable: {String(caps.error)}</div>

  const sel = selection
  // A selected link is the node pair; either direction may be missing.
  const linkSel = sel?.kind === 'edge' && (snap.data?.edges ?? []).some((e) => (e.src === sel.src && e.dst === sel.dst) || (e.src === sel.dst && e.dst === sel.src)) ? sel : undefined
  const counts = snap.data?.counts
  const empty = snap.data && counts && counts.packets === 0 && (snap.data.nodes ?? []).length === 0

  return (
    <div className="app">
      <header className="topbar">
        <h1>Mesh Observatory</h1>
        {counts && (
          <span className="counters" aria-live="polite">
            {counts.nodes} nodes · {counts.referenced} referenced · {counts.positioned} positioned · {counts.estimated} estimated · {counts.edges} links · {counts.packets} packets / {counts.receptions} receptions
          </span>
        )}
        {snap.isFetching && <span className="spinner" aria-label="Updating" />}
        {canInstall && <button className="install-btn" onClick={install} title="Install Mesh Observatory as an app on this device">Install app</button>}
        <button className="panel-toggle" aria-expanded={panelOpen} aria-controls="sidebar" onClick={togglePanel} title={panelOpen ? 'Hide the side panel' : 'Show nodes, details, filters and legend'}>
          {panelOpen ? 'Hide panel' : 'Nodes & details'}
        </button>
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
            {tab === 'details' && (sel?.kind === 'node' ? <NodePanel id={sel.id} snapshot={snap.data} /> : linkSel ? <EdgePanel a={linkSel.src} b={linkSel.dst} snapshot={snap.data} /> : <div className="panel muted">Select a node or link on the map or in the list.</div>)}
            {tab === 'filters' && <FilterPanel snapshot={snap.data} />}
            {tab === 'legend' && <Legend snapshot={snap.data} />}
          </div>
        </aside>
        <div className="banners">
          {(!online || servedOffline) && (
            <div className="banner hist" role="status">
              Offline: showing the data last received{snap.data ? ` (${new Date(snap.data.meta.generated_at).toLocaleString()})` : ''}. Live updates resume when the connection returns.
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
