import type { MeshNode, SnapshotView } from '../derive/views'
import { useStore } from '../state/store'
import { ageColor, lastHeardAge, nodeName } from '../map/model'
import { PALETTES } from '../map/palette'
import { useTheme } from '../theme'

export function NodeList({ snapshot }: { snapshot: SnapshotView | undefined }) {
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const select = useStore((s) => s.select)
  const nodes = snapshot?.nodes ?? []
  const q = search.trim().toLowerCase()
  const match = (n: MeshNode) =>
    !q || n.id.includes(q) || (n.identity?.long_name ?? '').toLowerCase().includes(q) || (n.identity?.short_name ?? '').toLowerCase().includes(q)
  const w = snapshot?.meta.window
  const endMs = w ? Date.parse(w.end) : 0, windowMs = w ? endMs - Date.parse(w.start) : 0
  // Most recently heard first (the dot's colour), then by name.
  const byRecent = (a: MeshNode, b: MeshNode) => lastHeardAge(a, endMs, windowMs) - lastHeardAge(b, endMs, windowMs) || nodeName(a, a.id).localeCompare(nodeName(b, b.id))
  const positioned = nodes.filter((n) => (n.position || n.estimate) && match(n)).sort(byRecent)
  const unpositioned = nodes.filter((n) => !n.position && !n.estimate && match(n)).sort(byRecent)
  // Same last-heard colour as the map marker.
  const stops = PALETTES[useTheme()].ageStops
  const dotStyle = (n: MeshNode) => {
    if (!w || (!n.position && !n.estimate)) return undefined
    const c = `rgb(${ageColor(lastHeardAge(n, endMs, windowMs), stops).join(',')})`
    return n.position ? { background: c } : { borderColor: c }
  }
  const row = (n: MeshNode) => (
    <li key={n.id}>
      <button className="node-row" onClick={() => select({ kind: 'node', id: n.id })}>
        <span className={`dot ${n.position ? 'rep' : n.estimate ? 'est' : n.status === 'referenced' ? 'ref' : 'unp'}`} style={dotStyle(n)} aria-hidden />
        <span className="nm">{nodeName(n, n.id)}</span>
        {nodeName(n, n.id) !== n.id && <span className="id">{n.id}</span>}
        {n.status === 'referenced'
          ? <span className="ct" title="Never heard itself: only named in others' NeighborInfo or traceroutes">named</span>
          : <span className="ct" title="Its unique packets / receptions of them by other gateways">{n.packets}/{n.receptions - (n.own_uplinks ?? 0)}</span>}
      </button>
    </li>
  )
  return (
    <div className="panel">
      <input className="search" type="search" placeholder="Search in-window nodes (id or name)" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search nodes" />
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
