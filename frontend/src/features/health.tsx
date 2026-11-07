// Mesh health (D-095): the engine's rules for known problems, and its
// airtime estimate. The Health panel lists every issue in the window; the
// node panel shows the selected node's.
import { useState } from 'react'
import type { HealthView, Issue, NodeAirtime, SnapshotView } from '../derive/views'
import { useHealth } from '../state/data'
import { useStore } from '../state/store'
import { TYPE_LABEL } from './controls'
import { namesOf } from '../map/model'

const SEVERITY: Record<Issue['severity'], { label: string; plural: string; icon: string }> = {
  problem: { label: 'problem', plural: 'problems', icon: '⛔' },
  warning: { label: 'warning', plural: 'warnings', icon: '⚠️' },
  notice: { label: 'notice', plural: 'notices', icon: 'ℹ️' },
}

/** Issue kinds as section headings in the Health panel. */
const KIND: Record<string, string> = {
  silent: 'Silent routers and gateways',
  spoofed: 'Packets in its name failed verification',
  shared_key: 'Shared public key',
  traceroute_flood: 'Traceroute flooding',
  airtime: 'Large airtime share',
  channel_busy: 'Busy channel',
  airtime_limit: 'Near the duty-cycle limit',
  downlink: 'MQTT downlink',
  moving_gateway: 'Moving MQTT gateway',
  topic_region: 'Topic root and region differ',
  preset: 'Different preset than the mesh',
  isolated: 'Not reported by other gateways',
  hop_limit: 'Hop limit higher than needed',
  admin_refused: 'Remote admin refused',
  plaintext_uplink: 'Unencrypted MQTT uplink',
  chatty_position: 'Frequent positions',
  chatty_nodeinfo: 'Frequent NodeInfo',
  chatty_telemetry: 'Frequent telemetry',
  stale_position: 'Stale position',
  position_contradicted: 'Impossible position',
  battery_low: 'Low battery',
  battery_falling: 'Battery falling',
  store_forward: 'Store-and-forward airtime',
  restarted: 'Restarts',
  duplicate_name: 'Duplicate short name',
}

const pct = (x: number) => (x >= 0.1 ? `${Math.round(x * 100)} %` : `${(x * 100).toFixed(1)} %`)
const typeName = (t: string) => TYPE_LABEL[t] ?? t

function IssueLine({ i, name }: { i: Issue; name?: (id: string) => string }) {
  const select = useStore((s) => s.select)
  const [open, setOpen] = useState(false)
  // Other nodes in the text by name, as the line's own node is.
  const named = (t: string) => (name ? t.replace(/![0-9a-f]{8}/g, (id) => (name(id) === id ? id : `${name(id)} (${id})`)) : t)
  return (
    <li className={`issue issue-${i.severity}`} title={named(i.detail)}>
      <span className="issue-icon" aria-label={SEVERITY[i.severity].label}>{SEVERITY[i.severity].icon}</span>
      <span>
        {name && (
          <><button className="linkish" onClick={() => select({ kind: 'node', id: i.node })}>{name(i.node)}</button>: </>
        )}
        {named(i.summary)}
        {name && (
          <>
            {' '}
            <button className="linkish issue-more" aria-expanded={open} aria-label={open ? 'Hide the explanation' : 'Show the explanation'} onClick={() => setOpen(!open)}>{open ? '▴' : '▾'}</button>
          </>
        )}
        {(!name || open) && <><br /><small className="muted">{named(i.detail)}</small></>}
      </span>
    </li>
  )
}

/** A share as a thin bar with its percentage. */
function Share({ label, share, max, title, onClick }: { label: string; share: number; max: number; title?: string; onClick?: () => void }) {
  return (
    <li className="share" title={title}>
      {onClick ? <button className="linkish share-label" onClick={onClick}>{label}</button> : <span className="share-label">{label}</span>}
      <span className="share-bar"><span style={{ width: `${max > 0 ? (share / max) * 100 : 0}%` }} /></span>
      <span className="share-pct">{pct(share)}</span>
    </li>
  )
}

const AIRTIME_NOTE =
  'Estimated from what gateways reported: each packet counts once for its sender and once per relay seen rebroadcasting it, weighted by its size plus the fixed preamble every LoRa packet costs. Relays no gateway heard are missed, so this is a lower bound and a guide to proportions, not a measurement.'

/** The rail's Health panel: every known issue in the window, and airtime. */
export function HealthPanel({ snapshot }: { snapshot: SnapshotView | undefined }) {
  const h = useHealth()
  const select = useStore((s) => s.select)
  const names = namesOf(snapshot?.nodes) // the same names as Details and the node list
  const name = (id: string) => names.get(id) ?? id
  if (h.isLoading || !h.data) return <div className="panel muted">Checking the mesh…</div>
  const { issues, airtime } = h.data as HealthView
  const counts = (['problem', 'warning', 'notice'] as const).map((s) => [s, issues.filter((i) => i.severity === s).length] as const).filter(([, n]) => n > 0)
  const groups = new Map<string, Issue[]>()
  for (const i of issues) {
    const list = groups.get(i.kind)
    if (list) list.push(i)
    else groups.set(i.kind, [i])
  }
  const top = airtime.nodes.slice(0, 10)
  const maxNode = top[0]?.caused ?? 0
  return (
    <div className="panel health-panel">
      <p>
        {counts.length === 0
          ? 'No known issues in the selected period.'
          : counts.map(([s, n]) => `${n} ${n === 1 ? SEVERITY[s].label : SEVERITY[s].plural}`).join(' · ')}
      </p>
      <p className="muted small">Found by rules over the selected period and filters; open an issue (▾) for the explanation. Only what gateways reported is seen.</p>
      {[...groups].map(([kind, list]) => (
        <section key={kind}>
          <h3>{KIND[kind] ?? kind} ({list.length})</h3>
          <ul className="issues">{list.map((i) => <IssueLine key={i.kind + i.node} i={i} name={name} />)}</ul>
        </section>
      ))}
      <h3 title={AIRTIME_NOTE}>Airtime (estimated)</h3>
      {airtime.packets === 0 ? (
        <p className="muted">No radio packets in the selected period.</p>
      ) : (
        <>
          <p className="muted small" title={AIRTIME_NOTE}>
            {airtime.packets} packets, {airtime.transmissions} transmissions seen. Share of the estimated airtime, by packet type:
          </p>
          <ul className="shares">{airtime.by_type.map(([t, s]) => <Share key={t} label={typeName(t)} share={s} max={airtime.by_type[0][1]} />)}</ul>
          <p className="muted small">The nodes whose packets, with their rebroadcasts, take the most:</p>
          <ul className="shares">
            {top.map((a) => (
              <Share key={a.node} label={name(a.node)} share={a.caused} max={maxNode} onClick={() => select({ kind: 'node', id: a.node })}
                title={`${a.packets} packets, ${a.transmissions} transmissions seen · ${a.by_type.slice(0, 3).map(([t, s]) => `${typeName(t)} ${pct(s)}`).join(', ')}`} />
            ))}
          </ul>
          <StoreForwardSection sf={airtime.store_forward} name={name} />
        </>
      )}
    </div>
  )
}

/** Store-and-forward kinds in plain words (D-103). */
const SF_KIND: Record<string, string> = {
  router_heartbeat: 'heartbeats', router_text_broadcast: 'replayed broadcasts', router_text_direct: 'replayed direct messages', router_history: 'history announcements',
  router_stats: 'statistics', router_ping: 'pings', router_pong: 'pongs', router_busy: 'busy replies', router_error: 'errors',
  client_history: 'history requests', client_stats: 'statistics requests', client_ping: 'client pings', client_pong: 'client pongs', client_abort: 'aborts', client_error: 'client errors',
  unknown: 'not decoded (older rows)',
}
const sfKind = (k: string) => SF_KIND[k] ?? k.replaceAll('_', ' ')

/** What store-and-forward costs in airtime, by kind and by router (D-103). */
function StoreForwardSection({ sf, name }: { sf: HealthView['airtime']['store_forward']; name: (id: string) => string }) {
  const select = useStore((s) => s.select)
  if (!sf || sf.packets === 0) return null
  const maxKind = sf.by_kind[0]?.[2] ?? 0
  const maxNode = sf.nodes[0]?.share ?? 0
  return (
    <>
      <h3 title="Store-and-forward routers keep recent messages and replay them to nodes that ask; they also send heartbeats so clients know they exist">Store and forward</h3>
      <p className="muted small">{sf.packets} packets, about {pct(sf.share)} of the estimated airtime. By kind:</p>
      <ul className="shares">{sf.by_kind.map(([k, n, share]) => <Share key={k} label={`${sfKind(k)} (${n})`} share={share} max={maxKind} />)}</ul>
      <p className="muted small">By router (share of all airtime):</p>
      <ul className="shares">
        {sf.nodes.map((f) => (
          <Share key={f.node} label={name(f.node)} share={f.share} max={maxNode} onClick={() => select({ kind: 'node', id: f.node })}
            title={`${f.packets} packets · ${f.heartbeats_per_hour.toFixed(1)} heartbeats per hour · ${f.replays} replays (${f.replay_bytes} bytes of text) · ${f.by_kind.map(([k, n]) => `${n} ${sfKind(k)}`).join(', ')}`} />
        ))}
      </ul>
    </>
  )
}

/** The selected node's issues, for the node panel: a compact count line above
 * the tabs that expands to the list, so issues are never hidden by a tab. */
export function NodeHealth({ id }: { id: string }) {
  const h = useHealth()
  const [open, setOpen] = useState(false)
  if (!h.data) return null
  const mine = h.data.issues.filter((i) => i.node === id)
  if (mine.length === 0) return <p className="node-health muted small" title="The health rules found nothing for this node in the selected period">✓ No known issues</p>
  const counts = (['problem', 'warning', 'notice'] as const)
    .map((s) => [s, mine.filter((i) => i.severity === s).length] as const)
    .filter(([, n]) => n > 0)
  return (
    <div className="node-health">
      <button className="linkish node-health-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title="Known problems found by the health rules (the Health panel lists all of them)">
        {counts.map(([s, n]) => `${SEVERITY[s].icon} ${n} ${n === 1 ? SEVERITY[s].label : SEVERITY[s].plural}`).join(' · ')} {open ? '▴' : '▾'}
      </button>
      {open && <ul className="issues">{mine.map((i) => <IssueLine key={i.kind} i={i} />)}</ul>}
    </div>
  )
}

/** The selected node's airtime, as a Details row. */
export function NodeAirtimeRow({ id }: { id: string }) {
  const h = useHealth()
  const a: NodeAirtime | undefined = h.data?.airtime.nodes.find((n) => n.node === id)
  if (!a) return null
  return (
    <>
      <dt title={AIRTIME_NOTE}>Airtime (est.)</dt>
      <dd title={AIRTIME_NOTE}>
        {a.caused > 0 && <>its packets: {pct(a.caused)}{a.by_type.length > 0 && <small className="muted"> ({a.by_type.slice(0, 3).map(([t, s]) => `${typeName(t)} ${pct(s)}`).join(', ')})</small>}<br /></>}
        <span title="What it transmitted itself: its own packets and others' it relayed">transmitted: {pct(a.transmitted)}</span>
      </dd>
    </>
  )
}
