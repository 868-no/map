import type { SnapshotBody } from '../api/types'
import { useStore, type Confidence } from '../state/store'
import { AGE_STOPS, roleRadius } from '../map/model'
import { BASEMAP_GROUPS } from '../map/layers'

const TYPES = ['nodeinfo', 'position', 'telemetry', 'neighborinfo', 'traceroute', 'text', 'routing', 'other']
const EVIDENCE: [string, string][] = [['neighbor', 'NeighborInfo'], ['traceroute', 'Traceroute'], ['direct_rf', 'Direct gateway RF'], ['relay_hint', 'Inferred last hop']]

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

/** Map layer switches: mesh overlays and basemap groups. */
export function LayersPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useStore((s) => s.toggles)
  const setT = useStore((s) => s.setToggles)
  // Each switch explains its data in a tooltip (title) shown on hover.
  const check = (label: string, on: boolean, change: (v: boolean) => void, info: string, disabled = false) => (
    <label key={label} className={disabled ? 'muted' : undefined} title={info}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => change(e.target.checked)} /> {label}
    </label>
  )
  return (
    <div id={id} className="popover layers-panel" role="dialog" aria-label="Map layers" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <button className="close" onClick={onClose} aria-label="Close layers">×</button>
      <h3>Mesh</h3>
      {check('Infrastructure links (router ↔ router)', t.infraLinks, (v) => setT({ infraLinks: v }),
        'Radio links where both nodes announce the ROUTER or ROUTER_LATE role in this window. Thick blue lines, one per node pair. Each link is backed by NeighborInfo, traceroute, direct gateway reception or a resolved relay byte observed in the selected window.')}
      {check('Other links', t.otherLinks, (v) => setT({ otherLinks: v }),
        'Radio links where at least one node has another role, or announced no role in this window. Thin grey-blue lines, backed by the same in-window evidence as infrastructure links.')}
      {check('Inferred links (dashed)', t.inferred, (v) => setT({ inferred: v }),
        'Links supported only by a relay\'s last-hop byte, resolved to a single node by radio range and confirmed links. Low confidence: never directly measured.', !t.infraLinks && !t.otherLinks)}
      {check('Accuracy circles (always shown for the selected node)', t.uncertainty, (v) => setT({ uncertainty: v }),
        'For estimated positions: the area the node is likely within, from the positioned nodes that heard it directly. For a selected node with a coarse reported position: how far off that position may be.')}
      {check('Node names (zoom ≥ 10)', t.labels, (v) => setT({ labels: v }),
        'Each node\'s short name from its latest NodeInfo in the selected window (or the last 4 hex digits of its ID if none).')}
      {check('Animated traffic', t.animation, (v) => setT({ animation: v }),
        'Live radar pings: each soft ring is one radio transmission, growing to enclose the nodes known to have heard it directly, while a bright line travels along each link to those nodes, arriving with the ring. Blue: first broadcast by the originating node; amber: rebroadcast by a relay. The ring fades with measured signal strength. Live window only.')}
      <h3>Map</h3>
      {BASEMAP_GROUPS.map((g) => check(g.label, t.basemap[g.id], (v) => setT({ basemap: { [g.id]: v } }), g.info))}
    </div>
  )
}

export function FilterPanel({ snapshot }: { snapshot: SnapshotBody | undefined }) {
  const f = useStore((s) => s.filters)
  const set = useStore((s) => s.setFilters)
  const brokers = [...new Set((snapshot?.nodes ?? []).flatMap((n) => n.brokers ?? []))].sort()
  return (
    <div className="panel">
      <h3>Nodes</h3>
      <label><input type="checkbox" checked={f.positionedOnly} onChange={(e) => set({ positionedOnly: e.target.checked })} /> Only nodes with reported positions</label>
      <p className="muted">Map layers (links, labels, place names…) are under Layers on the map.</p>

      <h3>Link evidence</h3>
      {EVIDENCE.map(([k, label]) => (
        <label key={k}><input type="checkbox" checked={f.evidence.length === 0 || f.evidence.includes(k)} onChange={() => set({ evidence: toggle(f.evidence.length ? f.evidence : EVIDENCE.map((e) => e[0]), k) })} /> {label}</label>
      ))}
      <label>
        Minimum confidence{' '}
        <select value={f.minConfidence} onChange={(e) => set({ minConfidence: e.target.value as Confidence })}>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </label>

      <h3>Packet types</h3>
      <p className="muted">Restricts which observations contribute to nodes, links and counts.</p>
      <div className="chips">
        {TYPES.map((ty) => (
          <button key={ty} aria-pressed={f.types.includes(ty)} onClick={() => set({ types: toggle(f.types, ty) })}>{ty}</button>
        ))}
      </div>
      <h3>Channel</h3>
      <input type="text" placeholder="e.g. NarrowFast (comma-separated)" defaultValue={f.channels.join(',')} onBlur={(e) => set({ channels: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
      {brokers.length > 0 && (
        <>
          <h3>Broker</h3>
          <div className="chips">
            {brokers.map((b) => (
              <button key={b} aria-pressed={f.brokers.includes(b)} onClick={() => set({ brokers: toggle(f.brokers, b) })}>{b}</button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ago(ms: number): string {
  const h = ms / 3600_000
  if (h === 0) return 'window end'
  return h <= 72 ? `${+h.toFixed(1)} h before` : `${+(h / 24).toFixed(1)} d before`
}

export function Legend({ snapshot }: { snapshot: SnapshotBody | undefined }) {
  const w = snapshot?.meta.window
  const windowMs = w ? Date.parse(w.end) - Date.parse(w.start) : 72 * 3600_000
  const gradient = `linear-gradient(to right, ${AGE_STOPS.map((c) => `rgb(${c.join(',')})`).join(', ')})`
  const size = (role: string) => ({ width: roleRadius(role) * 2, height: roleRadius(role) * 2 })
  return (
    <div className="panel legend">
      <h3>Nodes: colour is last heard</h3>
      <div className="age-ramp" style={{ background: gradient }} aria-hidden />
      <div className="age-labels">
        {AGE_STOPS.map((_, i) => (
          <span key={i}>{ago((windowMs * i) / (AGE_STOPS.length - 1))}</span>
        ))}
      </div>
      <p className="muted">The scale spans the selected window{w?.rolling ? ' (window end = now)' : ''}.</p>
      <h3>Nodes: size is role</h3>
      <ul>
        <li><span className="dot rep" style={size('ROUTER')} /> Router (ROUTER, ROUTER_LATE)</li>
        <li><span className="dot rep" style={size('CLIENT_BASE')} /> Client base (CLIENT_BASE)</li>
        <li><span className="dot rep" style={size('CLIENT')} /> Any other role, or role not reported</li>
      </ul>
      <h3>Node markers</h3>
      <ul>
        <li><span className="dot rep" /> Reported position (from an in-window Position packet or map report)</li>
        <li><span className="dot rep gwring glyph">↑</span> MQTT gateway: uplinks what it hears to the broker</li>
        <li><span className="dot rep glyph">↓</span> Probably downlinks: transmits packets it takes from the broker (its traceroute hops read exactly 0 dB, as packets from MQTT do)</li>
        <li><span className="dot rep gwring glyph">↕</span> Both uplinks and downlinks</li>
        <li><span className="dot rep optout" /> Red ring: did not allow MQTT uplink; reached us through another gateway, so the name is withheld</li>
        <li><span className="dot est" /> Estimated location — translucent circle is the uncertainty</li>
        <li>Selecting a node shows its accuracy circle (estimate uncertainty, or the precision of a coarse reported position) and only its links.</li>
        <li><span className="dot unp" /> No position: listed under “Without position”</li>
      </ul>
      <h3>Links (one line per node pair)</h3>
      <ul>
        <li><span className="ln infra thick" /> Infrastructure: both ends are ROUTER or ROUTER_LATE</li>
        <li><span className="ln other thin" /> Other: at least one end has another role (or none reported)</li>
      </ul>
      <h3>Link confidence</h3>
      <ul>
        <li><span className="ln infra c-high" /> High (solid): NeighborInfo or traceroute</li>
        <li><span className="ln infra c-medium" /> Medium (fainter): direct gateway RF reception</li>
        <li><span className="ln infra c-low dashed" /> Low, inferred (dashed): unique relay-byte match</li>
        <li>A line takes the better direction's confidence. Select a link to see which directions were heard and each direction's details.</li>
      </ul>
      <h3>Live traffic (radar pings)</h3>
      <ul>
        <li><span className="ping origin" /> First broadcast, centred on the originating node</li>
        <li><span className="ping relay" /> Rebroadcast, centred on the relay (resolved from the last-hop byte)</li>
        <li>The ring grows until it encloses every node known to have heard that transmission directly, and a bright line travels along the link to each of them; each one flashes as the ring and its line reach it. A small blip means no direct receiver is known yet.</li>
      </ul>
      <h3>Signatures</h3>
      <ul>
        <li><span className="sig sig-verified">verified</span> XEdDSA signature checked against an authoritative key</li>
        <li><span className="sig sig-unsigned">unsigned</span> older firmware or too large to sign</li>
        <li><span className="sig sig-unverifiable">signed, key unknown</span> not authenticated</li>
      </ul>
      <p className="muted">Channel decryption alone never implies authenticity. Positions without a reported packet are estimates, not GPS.</p>
    </div>
  )
}
