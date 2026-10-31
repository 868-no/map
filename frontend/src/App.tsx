import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { subscribeLive } from './api/client'
import MapView from './map/MapView'
import { addTransmission, clearPings, distanceM, MIN_RELAY_RANGE_M, RELAY_RANGE_SLACK, transmissions, pingWanted, type MeshContext, type Reception } from './map/pings'
import Timeline from './timeline/Timeline'
import { usePwa } from './pwa'
import { EdgePanel, NodeList, NodePanel } from './features/panels'
import { FilterPanel, Legend } from './features/controls'
import { DERIVE, useCapabilities, useLiveEpoch, useRetention, useSnapshot, useTraffic } from './state/data'
import { initDerive, sendLiveRows } from './derive/client'
import { receptionFromRow } from './derive/live'
import { applyFilters } from './derive/views'
import { apiParams, defaultFilters, fromQuery, toQuery, useStore } from './state/store'

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
  }, [])
  // Everything the ping animation needs to attribute rebroadcasts to relays.
  const mesh = useRef<MeshContext>({ nodes: [], confirmed: () => false, role: () => undefined, pos: () => undefined, maxRangeM: MIN_RELAY_RANGE_M })
  useEffect(() => {
    const nodes = snap.data?.nodes ?? []
    const roles = new Map(nodes.map((n) => [n.id, n.identity?.role || undefined]))
    const reported = new Map<string, [number, number]>(nodes.flatMap((n) => (n.position ? [[n.id, [n.position.lon, n.position.lat]] as [string, [number, number]]] : [])))
    // Only evidence that does not itself come from relay bytes.
    const confirmed = (snap.data?.edges ?? []).filter((e) => e.evidence.neighbor + e.evidence.traceroute + e.evidence.direct_rf > 0)
    const pairs = new Set(confirmed.flatMap((e) => [`${e.src}|${e.dst}`, `${e.dst}|${e.src}`]))
    let longest = 0
    for (const e of confirmed) {
      const a = reported.get(e.src), b = reported.get(e.dst)
      if (a && b) longest = Math.max(longest, distanceM(a, b))
    }
    mesh.current = {
      nodes: nodes.map((n) => n.id), confirmed: (a, b) => pairs.has(`${a}|${b}`), role: (id) => roles.get(id),
      pos: (id) => reported.get(id), maxRangeM: Math.max(MIN_RELAY_RANGE_M, longest * RELAY_RANGE_SLACK),
    }
  }, [snap.data])

  // The derivation worker applies the operator's geolocation settings.
  useEffect(() => {
    if (DERIVE === 'client' && caps.data) initDerive(caps.data)
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

  // Live updates for the rolling window only.
  const bump = useLiveEpoch((s) => s.bump)
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const liveFilters = DERIVE === 'client' ? null : filters // built in the browser: the stream carries every row
  useEffect(() => {
    if (!win.live) return
    const client = DERIVE === 'client'
    const params = apiParams({ win, filters: client ? defaultFilters : liveFilters! })
    let lastRefresh = Date.now() // the views were just loaded
    let wasLive = true
    let clockOffset = 0 // server time minus local time, from heartbeats
    const ping = (ev: Reception, observedMs: number) => {
      if (!pingWanted(observedMs, Date.now() + clockOffset, document.hidden)) return
      for (const t of transmissions(ev, mesh.current)) addTransmission(t, geo.current)
    }
    const unsub = subscribeLive(params, {
      onHeartbeat: (h) => {
        clockOffset = Date.parse(h.now) - Date.now()
        // Server views: refresh so new and aged-out evidence shows (~30 s).
        // Browser views get every row from the stream; this sync only fills
        // gaps the stream might have left, so once a minute is enough.
        if (Date.now() - lastRefresh > (client ? 60_000 : 30_000)) {
          lastRefresh = Date.now()
          bump(h.window.end)
        }
      },
      onDelta: (events) => {
        if (client) {
          const rows = events.flatMap((e) => (e.row ? [e.row] : []))
          sendLiveRows(rows)
          const f = filtersRef.current
          for (const r of applyFilters(rows, { channels: f.channels, brokers: f.brokers, types: f.types })) {
            if (r.y !== 'mapreport') ping(receptionFromRow(r), r.t) // a node's own MQTT report, not a radio transmission
          }
          return
        }
        for (const ev of events) {
          if (ev.type === 'mapreport') continue
          ping({ ...ev, relay: ev.relay ?? undefined, hops: ev.hops ?? undefined, path: ev.path ?? null, snr: ev.snr ?? undefined, rssi: ev.rssi ?? undefined }, Date.parse(ev.t))
        }
      },
      onStatus: (ok) => {
        setLiveOK(ok)
        // Back after an interruption: fetch whatever the stream missed.
        if (ok && !wasLive && client) {
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
  }, [win, liveFilters, bump, qc])

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
