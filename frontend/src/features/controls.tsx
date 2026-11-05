import type { SnapshotView } from '../derive/views'
import { defaultFilters, useStore, type Confidence, type Filters } from '../state/store'
import { ageMs, MQTT_ARROW, roleRadius, type MqttFlow } from '../map/model'
import { PALETTES } from '../map/palette'
import { useTheme } from '../theme'
import { BASEMAP_GROUPS } from '../map/layers'

const TYPES = ['nodeinfo', 'position', 'telemetry', 'neighborinfo', 'traceroute', 'text', 'routing', 'direct_message', 'encrypted', 'store_forward', 'node_status', 'mapreport', 'other']
export const TYPE_LABEL: Record<string, string> = { mapreport: 'map report', direct_message: 'direct message', store_forward: 'store & forward', node_status: 'node status' }
const TYPE_TIP: Record<string, string> = {
  mapreport: 'Map reports: a node sends these to the MQTT broker itself, not over the radio',
  store_forward: 'Store-and-forward: routers that keep and replay recent messages, and their heartbeats',
  node_status: 'Status texts nodes broadcast about themselves',
  encrypted: 'Packets on channels this map has no key for: only who sent them, their size and how they travelled are known',
  direct_message: 'Direct messages encrypted end to end: only who sent one to whom, its size and how it travelled are known, never the content',
  other: 'Packets of any other application (admin, store and forward, range test, …)',
}
const EVIDENCE: [string, string][] = [['neighbor', 'NeighborInfo'], ['traceroute', 'Traceroute'], ['direct_rf', 'Heard directly by a gateway'], ['relay_hint', 'Guessed from relay byte']]

/** Meshtastic device roles in plain words (the raw enum is the fallback). */
export const ROLE_LABEL: Record<string, string> = {
  CLIENT: 'Client', CLIENT_MUTE: 'Client (mute)', CLIENT_HIDDEN: 'Client (hidden)', CLIENT_BASE: 'Client base',
  ROUTER: 'Router', ROUTER_LATE: 'Router (late)', ROUTER_CLIENT: 'Router/client', REPEATER: 'Repeater',
  TRACKER: 'Tracker', SENSOR: 'Sensor', TAK: 'TAK', TAK_TRACKER: 'TAK tracker', LOST_AND_FOUND: 'Lost and found',
}
const roleLabel = (r: string) => ROLE_LABEL[r] ?? r

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

/** How many filters differ from the defaults (the Filters button's badge). */
export function activeFilters(f: Filters): number {
  return [f.positionedOnly, f.onlineOnly, f.roles.length > 0, f.evidence.length > 0 && f.evidence.length < EVIDENCE.length, f.minConfidence !== 'low', f.types.length > 0, f.channels.length > 0, f.brokers.length > 0].filter(Boolean).length
}

/** Map layer switches: mesh overlays and basemap groups. */
export function LayersPanel() {
  const t = useStore((s) => s.toggles)
  const setT = useStore((s) => s.setToggles)
  // Each switch explains its data in a tooltip (title) shown on hover.
  const check = (label: string, on: boolean, change: (v: boolean) => void, info: string, disabled = false) => (
    <label key={label} className={disabled ? 'muted' : undefined} title={info}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => change(e.target.checked)} /> {label}
    </label>
  )
  return (
    <div className="panel layers-panel">
      <h3>Mesh</h3>
      {check('Router links', t.infraLinks, (v) => setT({ infraLinks: v }),
        'Radio links between two nodes that both announce the ROUTER or ROUTER_LATE role in the selected window. Thick blue lines, one per node pair. Each is backed by evidence from the window: NeighborInfo, a traceroute hop, a direct gateway reception, or a relay\'s last-hop byte resolved to a single node. Internet links are never included. A gold chevron marks a 0-cost direction: the router it points at relays the other\'s packets without spending a hop.')}
      {check('Client links', t.otherLinks, (v) => setT({ otherLinks: v }),
        'Radio links where at least one node has another role (a client role) or announced no role in the selected window. Thin grey lines, backed by the same kinds of evidence as router links.')}
      {check('Internet links', t.mqttLinks, (v) => setT({ mqttLinks: v }),
        'Hops that crossed the internet instead of the air: a gateway uplinked the packet to an MQTT broker, and the receiving node took it from the broker (downlink) and transmitted it. Found in traceroutes, which record these hops at exactly 0 dB, into nodes marked ↓. Dotted green lines. Never counted as radio links or used for position estimates.')}
      {check('Inferred links', t.inferred, (v) => setT({ inferred: v }),
        'Dashed router or client links supported only by a relay\'s last-hop byte, resolved to a single node by radio range and confirmed links. Low confidence: never directly measured. Needs router or client links switched on.', !t.infraLinks && !t.otherLinks)}
      {check('Position accuracy', t.uncertainty, (v) => setT({ uncertainty: v }),
        'A circle around each estimated position: the area the node is likely within, from the positioned nodes that heard it directly. With a node selected, only its circle is shown, switched on or not; for a coarse reported position it shows how far off that position may be.')}
      {check('Node names', t.labels, (v) => setT({ labels: v }),
        'Each node\'s short name from its latest NodeInfo (or its own map report) in the selected window, or the last 4 hex digits of its ID. Shown from zoom 10. Names that would overlap are grouped (“+N”) and fan out when hovered.')}
      {check('Position trails', t.trails, (v) => setT({ trails: v }),
        'Which way moving nodes are going: a short line through their last few reported positions, fading towards the oldest, with chevrons pointing the way they went. With a node selected, only its trail. A node counts as moving once two positions lie further apart than 300 m (2 km for routers and base stations, whose GPS may wander) plus what their precision explains; its links then use only evidence from after its latest move.')}
      {check('Traffic', t.animation, (v) => setT({ animation: v }),
        'Live radar pings: each ring is one radio transmission, growing until it encloses the nodes known to have heard it directly, while a bright line travels to each of those nodes, arriving with the ring. Blue: first broadcast by the originating node; amber: rebroadcast by a relay. The ring fades outward, matching the signal strength measured at each receiver. Live window only; off by default when the system asks for reduced motion.')}
      <h3>Map</h3>
      {BASEMAP_GROUPS.map((g) => check(g.label, t.basemap[g.id], (v) => setT({ basemap: { [g.id]: v } }), g.info))}
      {check('Regions (landsdeler)', t.regions, (v) => setT({ regions: v }),
        'Norway\'s five regions: Nord-Norge (Nordland, Troms, Finnmark), Trøndelag, Vestlandet (Rogaland, Vestland, Møre og Romsdal), Østlandet (Oslo, Akershus, Østfold, Buskerud, Vestfold, Telemark, Innlandet) and Sørlandet (Agder). Outlines drawn just inside each region (no fill), named at overview zooms. Boundaries from Kartverket\'s county data (CC BY 4.0), simplified.')}
    </div>
  )
}

export function FilterPanel({ snapshot }: { snapshot: SnapshotView | undefined }) {
  const f = useStore((s) => s.filters)
  const set = useStore((s) => s.setFilters)
  const brokers = [...new Set((snapshot?.nodes ?? []).flatMap((n) => n.brokers ?? []))].sort()
  // Roles present in the window, plus any selected one that is not (so it can still be toggled off).
  const roles = [...new Set([...(snapshot?.nodes ?? []).flatMap((x) => (x.identity?.role ? [x.identity.role] : [])), ...f.roles])].sort()
  const n = activeFilters(f)
  return (
    <div className="panel">
      <p className="muted filter-head">
        {n ? `${n} filter${n === 1 ? '' : 's'} active.` : 'Everything in the window counts.'}{' '}
        {n > 0 && <button className="linkish" onClick={() => set(defaultFilters)}>Reset</button>}
      </p>
      <h3>Nodes</h3>
      <label><input type="checkbox" checked={f.positionedOnly} onChange={(e) => set({ positionedOnly: e.target.checked })} /> Only nodes with reported positions</label>
      <label title="Online: heard within the last 3 hours of the selected period (now, when live). Nodes only named by others are offline."><input type="checkbox" checked={f.onlineOnly} onChange={(e) => set({ onlineOnly: e.target.checked })} /> Only online nodes (heard in the last 3 h)</label>
      {roles.length > 0 && (
        <>
          <p className="muted small" title="Show only nodes whose latest reported role in the window is one of those selected. Nodes that announce no role are hidden while any role is chosen. Roles come from NodeInfo or a node's own map report.">Only these roles:</p>
          <div className="chips">
            {roles.map((r) => (
              <button key={r} aria-pressed={f.roles.includes(r)} onClick={() => set({ roles: toggle(f.roles, r) })}>{roleLabel(r)}</button>
            ))}
          </div>
        </>
      )}
      <p className="muted">These and the link filters below change what the map draws, not the counts in the header or a node's details.</p>

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
      <p className="muted">These, the channel and the broker restrict which observations count at all: nodes, links, the header's counts and node details.</p>
      <div className="chips">
        {TYPES.map((ty) => (
          <button key={ty} title={TYPE_TIP[ty]} aria-pressed={f.types.includes(ty)} onClick={() => set({ types: toggle(f.types, ty) })}>{TYPE_LABEL[ty] ?? ty}</button>
        ))}
      </div>
      <h3>Channel</h3>
      <input key={f.channels.join(',')} type="text" aria-label="Channels" placeholder="e.g. NarrowFast (comma-separated)" defaultValue={f.channels.join(',')} onBlur={(e) => set({ channels: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
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
  const min = ms / 60_000
  if (min < 0.5) return 'now'
  if (min < 90) return `${Math.round(min)} min`
  const h = min / 60
  return h <= 72 ? `${+h.toFixed(h < 10 ? 1 : 0)} h` : `${+(h / 24).toFixed(1)} d`
}

export function Legend({ snapshot }: { snapshot: SnapshotView | undefined }) {
  const w = snapshot?.meta.window
  const windowMs = w ? Date.parse(w.end) - Date.parse(w.start) : 72 * 3600_000
  const stops = PALETTES[useTheme()].ageStops
  const gradient = `linear-gradient(to right, ${stops.map((c) => `rgb(${c.join(',')})`).join(', ')})`
  const size = (role: string) => ({ width: roleRadius(role) * 2, height: roleRadius(role) * 2 })
  return (
    <div className="panel legend">
      <h3>Nodes: colour is last heard</h3>
      <div className="age-ramp" style={{ background: gradient }} aria-hidden />
      <div className="age-labels">
        {stops.map((_, i) => (
          <span key={i}>{ago(ageMs(i / (stops.length - 1), windowMs))}</span>
        ))}
      </div>
      <p className="muted">
        Time before the window's end{w?.rolling ? ' (now)' : ''} that it was last heard, or uplinked something as a gateway, on a logarithmic scale across the selected window: recent activity is spread out. A node only named by others counts from when it was last named.
      </p>
      <h3>Nodes: size is role</h3>
      <ul>
        <li><span className="dot rep" style={size('ROUTER')} /> Router (ROUTER, ROUTER_LATE)</li>
        <li><span className="dot rep" style={size('CLIENT_BASE')} /> Client base (CLIENT_BASE)</li>
        <li><span className="dot rep" style={size('CLIENT')} /> Any other role, or role not reported</li>
      </ul>
      <h3>Node markers</h3>
      <ul>
        <li><span className="dot rep" /> Reported position (from an in-window Position packet or map report). When its reports jump around one place, they are combined into a narrower position.</li>
        <li><span className="dot rep gwring glyph"><FlowIcon flow="up" /></span> MQTT gateway: uplinks the first copy of each packet it hears to the broker</li>
        <li><span className="dot rep gwring glyph"><FlowIcon flow="upAll" /></span> MQTT gateway that uplinks every copy it hears, each with its own last hop (a firmware option)</li>
        <li><span className="glyph-badged"><span className="dot rep" /><FlowIcon flow="down" className="glyph-badge" /></span> Arrow beside the marker: probably downlinks, transmitting packets it takes from the broker (its traceroute hops read exactly 0 dB, as packets from MQTT do). Shown with either uplink glyph too.</li>
        <li><span className="dot rep optout" /> Red ring: did not allow MQTT uplink; reached us through another gateway, so the name is withheld</li>
        <li><span className="dot est" /> Estimated location (not reported): a hollow ring in its last-heard colour, name in purple. Its uncertainty circle shows when it is selected or Position accuracy is on.</li>
        <li>Selecting a node shows its accuracy circle (estimate uncertainty, or the precision of a coarse reported position) and only its links.</li>
        <li><span className="dot unp" /> No position: listed under “Without position”</li>
        <li><span className="chev" aria-hidden>✈</span> Airborne: moving and reporting more than 750 m above sea level (fixed mountain sites never get it)</li>
        <li><span className="chev" aria-hidden>›</span> Position trail: a moving node's last few positions, fading towards the oldest, chevrons pointing the way it is going. A move resets its links.</li>
      </ul>
      <h3>Links (one line per node pair)</h3>
      <ul>
        <li><span className="ln infra thick" /> Router: both ends are ROUTER or ROUTER_LATE</li>
        <li><span className="ln other thin" /> Client: at least one end has another role (or none reported)</li>
        <li><span className="ln mqtt" /> Internet (dotted green): not radio; the packet crossed an MQTT broker (a traceroute hop recorded at exactly 0 dB)</li>
        <li><span className="chev" aria-hidden>›</span> 0-cost (gold chevron, pointing at the receiver): a ROUTER, ROUTER_LATE or CLIENT_BASE that relays what it hears from this sender (a favourite of its own) without spending a hop. One direction only; the other may cost a hop. On router and client links alike.</li>
        <li>Reach (node details): links are replaced by the paths a packet takes, coloured by the hop limit that gets it there (dashed across relays without a position); nodes it cannot reach are dimmed.</li>
      </ul>
      <h3>Link confidence</h3>
      <ul>
        <li><span className="ln infra c-high" /> High (solid): observed 3 or more times, or in more than one way (NeighborInfo, traceroute, a gateway hearing it directly)</li>
        <li><span className="ln infra c-medium" /> Medium (fainter): observed once or twice</li>
        <li><span className="ln infra c-low dashed" /> Low, inferred (dashed): only guessed from relayed copies whose last-hop byte matched one known node</li>
        <li>A line takes the better direction's confidence. Select a link to see which directions were heard and each direction's details.</li>
      </ul>
      <h3>Packet route (a packet selected in a node's packet log)</h3>
      <ul>
        <li><span className="ln route" /> Orange, chevrons pointing from transmitter to receiver: a hop the packet took (traceroute, direct reception, or a relay resolved from the last-hop byte)</li>
        <li><span className="ln route dashed" /> Dashed: the path between the two ends is not known (missing or unplaced nodes, or relays that spent no hop)</li>
        <li><span className="ln mqtt" /> Dotted green: over the internet, an MQTT downlink, not radio</li>
        <li><span className="ln delivered" /> Dashed mint: delivery confirmed, the node sent an ACK for it (the path to it may not be known)</li>
        <li>A ring with a dashed line: a node that has moved, drawn where it was when the packet was heard. Links are hidden while a route is shown.</li>
      </ul>
      <h3>Live traffic (radar pings)</h3>
      <ul>
        <li><span className="ping origin" /> First broadcast, centred on the originating node</li>
        <li><span className="ping relay" /> Rebroadcast, centred on the relay (resolved from the last-hop byte)</li>
        <li><span className="ln delivered" /> Delivery: an ACK just confirmed that a node received another's packet; a line travels the packet's way from the sender to it (unless that packet was just animated), then the ACK's way back; each end flashes as a line arrives. Solid where a hop is known, dashed where not: straight across when where a node heard it from is not known.</li>
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

/** The MQTT glyph drawn inside map markers (map/model.ts MQTT_ARROW), for the legend. */
function FlowIcon({ flow, className }: { flow: MqttFlow; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className ?? 'flow-icon'} aria-hidden>
      <path d={MQTT_ARROW[flow]} />
    </svg>
  )
}
