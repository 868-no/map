import { useMemo } from 'react'
import type { MeshNode, SnapshotView } from '../derive/views'
import { useStore } from '../state/store'
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
      <input className="search" type="search" placeholder="Search in-window nodes (id or name)" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search nodes" />
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
