import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getJSON } from '../api/client'
import type { Place } from '../api/types'
import type { MeshNode, SnapshotView } from '../derive/views'
import { useStore } from '../state/store'
import { useCapabilities, useHealth, useWatched } from '../state/data'
import { allowNotifications, canNotify, useWatch, WATCH_BATTERY_LOW } from '../state/watch'
import { relativeAge } from '../lib/time'
import { ageColor, lastHeardAge, matchesSearch, nodeName, passesNodeFilters } from '../map/model'
import { PALETTES } from '../map/palette'
import { useTheme } from '../theme'

export function NodeList({ snapshot }: { snapshot: SnapshotView | undefined }) {
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const select = useStore((s) => s.select)
  const filters = useStore((s) => s.filters)
  const setFilters = useStore((s) => s.setFilters)
  const q = search.trim().toLowerCase()
  const w = snapshot?.meta.window
  const endMs = w ? Date.parse(w.end) : 0, windowMs = w ? endMs - Date.parse(w.start) : 0
  const { positioned, unpositioned, hidden, age, name } = useMemo(() => {
    const nodes = snapshot?.nodes ?? []
    // Age and name once per node, not once per comparison.
    const age = new Map<string, number>(), name = new Map<string, string>()
    for (const n of nodes) {
      age.set(n.id, lastHeardAge(n, endMs, windowMs))
      name.set(n.id, nodeName(n, n.id))
    }
    // The same node filters as the map (position, online, role), so the list matches it (D-145).
    const passing = nodes.filter((n) => passesNodeFilters(n, filters, endMs))
    const shown = passing.filter((n) => matchesSearch(n, q))
    // Most recently heard first (the dot's colour), then by name.
    const byRecent = (a: MeshNode, b: MeshNode) => age.get(a.id)! - age.get(b.id)! || name.get(a.id)!.localeCompare(name.get(b.id)!)
    return {
      positioned: shown.filter((n) => n.position || n.estimate).sort(byRecent),
      unpositioned: shown.filter((n) => !n.position && !n.estimate).sort(byRecent),
      hidden: nodes.length - passing.length,
      age,
      name,
    }
  }, [snapshot, filters, q, endMs, windowMs])
  // Same last-heard colour as the map marker.
  const stops = PALETTES[useTheme()].ageStops
  const dotStyle = (n: MeshNode) => {
    if (!w || (!n.position && !n.estimate)) return undefined
    const c = `rgb(${ageColor(age.get(n.id)!, stops).join(',')})`
    return n.position ? { background: c } : { borderColor: c }
  }
  const row = (n: MeshNode) => (
    <li key={n.id}>
      <button className="node-row" onClick={() => select({ kind: 'node', id: n.id })}>
        <span className={`dot ${n.position ? 'rep' : n.estimate ? 'est' : n.status === 'referenced' ? 'ref' : 'unp'}`} style={dotStyle(n)} aria-hidden />
        <span className="nm">{name.get(n.id)}</span>
        {name.get(n.id) !== n.id && <span className="id">{n.id}</span>}
        {n.status === 'referenced'
          ? <span className="ct" title="Never heard itself: only named in others' NeighborInfo or traceroutes">named</span>
          : <span className="ct" title="Its unique packets / receptions of them by other gateways">{n.packets}/{n.receptions - (n.own_uplinks ?? 0)}</span>}
      </button>
    </li>
  )
  return (
    <div className="panel">
      <WatchList now={endMs} />
      <input className="search" type="search" placeholder="Search nodes (id or name) or places" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search nodes and places" />
      <PlaceResults search={search} />
      {hidden > 0 && (
        <p className="node-filter-alert" role="status">
          ⚠ {hidden} node{hidden === 1 ? '' : 's'} hidden by the active node filters.{' '}
          <button className="linkish" onClick={() => setFilters({ positionedOnly: false, onlineOnly: false, roles: [] })}>Show all</button>
        </p>
      )}
      <p className="muted small">Most recently heard first. Numbers: its unique packets / receptions of them by other gateways.</p>
      <h3>On the map ({positioned.length})</h3>
      <ul className="node-list">{positioned.slice(0, 300).map(row)}</ul>
      {positioned.length > 300 && <p className="muted">Showing 300 of {positioned.length}; refine the search.</p>}
      <h3>Without position ({unpositioned.length})</h3>
      <p className="muted">Observed or referenced in this window, but no in-window position or estimate.</p>
      <ul className="node-list">{unpositioned.slice(0, 300).map(row)}</ul>
    </div>
  )
}

/**
 * The watchlist (D-192): nodes this browser keeps an eye on, above the
 * search, with what matters at a glance; optionally a notification when
 * one goes quiet, comes back, gets a problem or runs low.
 */
function WatchList({ now }: { now: number }) {
  const ids = useWatch((s) => s.ids)
  const toggle = useWatch((s) => s.toggle)
  const notify = useWatch((s) => s.notify)
  const setNotify = useWatch((s) => s.setNotify)
  const select = useStore((s) => s.select)
  const live = useStore((s) => s.win.live)
  const watched = useWatched(ids)
  const issues = useHealth().data?.issues ?? []
  const [refused, setRefused] = useState(false)
  if (ids.length === 0) return <p className="muted small watch-hint">Watch a node (☆ in its Details) to keep it here, with when it was last heard and its battery.</p>
  const onNotify = async (on: boolean) => {
    if (on && !(await allowNotifications())) return setRefused(true)
    setRefused(false)
    setNotify(on)
  }
  const nodes = watched.data?.nodes ?? []
  return (
    <section className="watch-list" aria-label="Watched nodes">
      <h3>Watched ({ids.length})</h3>
      <ul className="node-list">
        {nodes.map((w) => {
          const own = issues.filter((i) => i.node === w.id && i.severity !== 'notice')
          const bad = own.some((i) => i.severity === 'problem')
          const name = w.long_name || w.short_name || w.id
          const parts: string[] = []
          if (w.status === 'absent') parts.push('not heard in the selected period')
          else if (w.quiet) parts.push(`quiet for ${relativeAge(new Date(now - (w.quiet_ms ?? 0)).toISOString(), now).replace(/ ago$/, '')} (usually every ${Math.max(1, Math.round((w.usual_gap_ms ?? 0) / 60_000))} min)`)
          else if (w.last_seen) parts.push(`heard ${relativeAge(w.last_seen, now)}`)
          if (w.battery !== undefined) parts.push(w.battery > 100 ? 'external power' : `battery ${Math.round(w.battery)} %`)
          if (w.status !== 'absent') parts.push(`${w.gateways} gateway${w.gateways === 1 ? '' : 's'}`)
          const low = w.battery !== undefined && w.battery <= WATCH_BATTERY_LOW
          return (
            <li key={w.id} className={`watch-row${w.quiet || w.status === 'absent' ? ' quiet' : ''}`}>
              <button className="node-row" onClick={() => select({ kind: 'node', id: w.id })} disabled={w.status === 'absent'} title={w.status === 'absent' ? 'Not in the selected period' : 'Show its details'}>
                <span className="nm">{name}</span>
                {name !== w.id && <span className="id">{w.id}</span>}
                <span className="watch-state">
                  {parts.join(' · ')}
                  {low && <span className="watch-flag"> · low battery</span>}
                  {own.length > 0 && <span className={`watch-flag${bad ? ' bad' : ''}`}> · {own.length} {bad ? 'problem' : 'warning'}{own.length === 1 ? '' : 's'}</span>}
                </span>
              </button>
              <button className="linkish watch-remove" onClick={() => toggle(w.id)} aria-label={`Stop watching ${name}`} title="Stop watching">×</button>
            </li>
          )
        })}
      </ul>
      {canNotify() && (
        <label className="watch-notify" title={live ? 'A browser notification when a watched node goes quiet for much longer than usual, is heard again, gets a problem or warning, or its battery drops to 20 %. Only while this page is open in a live period: nothing runs on the server.' : 'Notifications follow the live period only.'}>
          <input type="checkbox" checked={notify} disabled={!live} onChange={(e) => void onNotify(e.target.checked)} /> Notify me while this page is open
        </label>
      )}
      {refused && <p className="muted small">The browser did not allow notifications for this site; its site settings can.</p>}
    </section>
  )
}

/** How close to go for a kind of place (Kartverket's types, in Norwegian). */
const PLACE_ZOOM: Record<string, number> = { Fylke: 7, Kommune: 9, By: 11, Tettsted: 12, Tettbebyggelse: 13, Bydel: 13, 'Administrativ bydel': 13, Tettsteddel: 14, Grend: 13, Innsjø: 11, Øy: 11, 'Øy i sjø': 11, Fjellområde: 10, Fjell: 12, Topp: 13 }

/**
 * Places matching the search (D-193), from Kartverket's place-name register
 * as this server keeps it: picking one moves the map there and rings it. Shown
 * once two characters are typed, after a short pause.
 */
function PlaceResults({ search }: { search: string }) {
  const enabled = !!useCapabilities().data?.features.places
  const goToPlace = useStore((s) => s.goToPlace)
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => {
    if (!search.trim()) goToPlace(null) // the ring goes with the search
  }, [search, goToPlace])
  const places = useQuery({
    queryKey: ['places', q.toLowerCase()],
    queryFn: ({ signal }) => getJSON<{ places: Place[] | null; attribution: string }>('/api/v1/places', new URLSearchParams({ q }), signal),
    enabled: enabled && [...q].length >= 2,
    staleTime: Infinity,
    retry: false,
  })
  const list = places.data?.places ?? []
  if (!enabled || [...q].length < 2 || list.length === 0) return null
  return (
    <section className="place-results" aria-label="Places">
      <h3>Places</h3>
      <ul className="node-list">
        {list.slice(0, 5).map((p) => (
          <li key={`${p.name}|${p.kind}|${p.lat}|${p.lon}`}>
            <button className="node-row place-row" onClick={() => goToPlace({ lon: p.lon, lat: p.lat, zoom: PLACE_ZOOM[p.kind] ?? 12, name: p.name })} title={`Show ${p.name} on the map`}>
              <span className="nm">{p.name}</span>
              <span className="ct">{[p.kind, p.municipality].filter(Boolean).join(' · ')}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">{places.data?.attribution}</p>
    </section>
  )
}
