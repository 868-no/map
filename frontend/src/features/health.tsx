// Mesh health (D-095): the engine's rules for known problems, and its
// airtime estimate. The Health panel lists every issue in the window; the
// node panel shows the selected node's.
import { useMemo } from 'react'
import type { HealthView, Issue, NodeAirtime, SnapshotView } from '../derive/views'
import { useHealth } from '../state/data'
import { useStore } from '../state/store'
import { TYPE_LABEL } from './controls'

const SEVERITY: Record<Issue['severity'], { label: string; plural: string; icon: string }> = {
  problem: { label: 'problem', plural: 'problems', icon: '⛔' },
  warning: { label: 'warning', plural: 'warnings', icon: '⚠️' },
  notice: { label: 'notice', plural: 'notices', icon: 'ℹ️' },
}

/** Issue kinds as section headings in the Health panel. */
const KIND: Record<string, string> = {
  traceroute_flood: 'Traceroute flooding',
  airtime: 'Large airtime share',
  channel_busy: 'Busy channel',
  airtime_limit: 'Near the duty-cycle limit',
  downlink: 'MQTT downlink',
  preset: 'Different preset than the mesh',
  isolated: 'Not reported by other gateways',
  hop_limit: 'Hop limit higher than needed',
  admin_refused: 'Remote admin refused',
  plaintext_uplink: 'Unencrypted MQTT uplink',
  chatty_position: 'Frequent positions',
  chatty_nodeinfo: 'Frequent NodeInfo',
  chatty_telemetry: 'Frequent telemetry',
  stale_position: 'Stale position',
  battery_low: 'Low battery',
  duplicate_name: 'Duplicate short name',
}

const pct = (x: number) => (x >= 0.1 ? `${Math.round(x * 100)} %` : `${(x * 100).toFixed(1)} %`)
const typeName = (t: string) => TYPE_LABEL[t] ?? t

function nameMap(snapshot: SnapshotView | undefined): Map<string, string> {
  const m = new Map<string, string>()
  for (const n of snapshot?.nodes ?? []) m.set(n.id, n.identity?.long_name || n.id)
  return m
}

function IssueLine({ i, name }: { i: Issue; name?: (id: string) => string }) {
  const select = useStore((s) => s.select)
  return (
    <li className={`issue issue-${i.severity}`} title={i.detail}>
      <span className="issue-icon" aria-label={SEVERITY[i.severity].label}>{SEVERITY[i.severity].icon}</span>
      <span>
        {name && (
          <><button className="linkish" onClick={() => select({ kind: 'node', id: i.node })}>{name(i.node)}</button>: </>
        )}
        {i.summary}
        {!name && <><br /><small className="muted">{i.detail}</small></>}
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
  const names = useMemo(() => nameMap(snapshot), [snapshot])
  const name = (id: string) => names.get(id) ?? id
  if (h.isLoading || !h.data) return <div className="panel muted">Checking the mesh…</div>
  const { issues, airtime } = h.data as HealthView
  const counts = (['problem', 'warning', 'notice'] as const).map((s) => [s, issues.filter((i) => i.severity === s).length] as const).filter(([, n]) => n > 0)
  const groups = new Map<string, Issue[]>()
  for (const i of issues) groups.set(i.kind, [...(groups.get(i.kind) ?? []), i])
  const top = airtime.nodes.slice(0, 10)
  const maxNode = top[0]?.caused ?? 0
  return (
    <div className="panel health-panel">
      <p>
        {counts.length === 0
          ? 'No known issues in the selected period.'
          : counts.map(([s, n]) => `${n} ${n === 1 ? SEVERITY[s].label : SEVERITY[s].plural}`).join(' · ')}
      </p>
      <p className="muted small">Found by rules over the selected period and filters; hover an issue for the explanation. Only what gateways reported is seen.</p>
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
        </>
      )}
    </div>
  )
}

/** The selected node's issues, for the node panel. */
export function NodeHealth({ id }: { id: string }) {
  const h = useHealth()
  if (!h.data) return null
  const mine = h.data.issues.filter((i) => i.node === id)
  return (
    <>
      <h3 title="Known problems found by the health rules (the Health panel lists all of them)">Health</h3>
      {mine.length === 0 ? <p className="muted small">No known issues.</p> : <ul className="issues">{mine.map((i) => <IssueLine key={i.kind} i={i} />)}</ul>}
    </>
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
