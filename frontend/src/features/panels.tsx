import { Fragment, useEffect, useMemo, useState } from 'react'
import { ApiError, getJSON } from '../api/client'
import { NodeAirtimeRow, NodeHealth } from './health'
import type { NodeKey } from '../api/types'
import type { Answer, Edge, Hearing, MeshNode, Radio, Reply, SnapshotView } from '../derive/views'
import { useLinkHistory, useNodeDetail, usePacketLog, usePacketRoute, useReach } from '../state/data'
import { nodeLink, useStore, type DetailTab } from '../state/store'
import { formatLocal, formatLogTime, relativeAge } from '../lib/time'
import { TimeChart } from '../components/TimeChart'
import { ageColor, isOnline, lastHeardAge, precisionErrorM } from '../map/model'
import { PALETTES } from '../map/palette'
import { useTheme } from '../theme'

const NR = <span className="nr">not reported in selected period</span>

function nodeName(n: MeshNode | undefined, id: string): string {
  return n?.identity?.long_name || n?.identity?.short_name || id
}

/** Packet log type labels and tooltips for header-only rows (D-091, D-093). */
const TYPE_SHORT: Record<string, string> = { direct_message: 'DM 🔒', encrypted: 'encrypted 🔒' }
const TYPE_TIP: Record<string, string> = {
  direct_message: 'Encrypted direct message: who sent it to whom is known, its content is not',
  encrypted: 'On a channel this map has no key for: who sent it is known, its content is not',
  invalid: 'Failed decoding or verification: content not kept, and the sender may be forged, so it counts for nothing else on the map',
}
const INVALID: Record<string, string> = {
  sig_invalid: 'its signature does not verify', sig_malformed: 'malformed signature', first_contact_invalid: 'its first NodeInfo failed verification',
  nodeinfo_key_mismatch: 'NodeInfo with a different key than the trusted one', strict_unverifiable: 'signed with an unknown key (strict policy)',
  payload_invalid: 'its payload does not decode', decode_failed: 'decrypted to nothing readable', plaintext_unconfigured: 'unencrypted uplink from a broker not trusted for that',
}

/** Firmware Routing.Error names in plain words (D-092). */
const ROUTING_ERROR: Record<string, string> = {
  NO_ROUTE: 'no route', GOT_NAK: 'refused', TIMEOUT: 'timed out', NO_INTERFACE: 'no interface', MAX_RETRANSMIT: 'gave up after retries',
  NO_CHANNEL: 'no matching channel', TOO_LARGE: 'too large', NO_RESPONSE: 'no response', DUTY_CYCLE_LIMIT: 'duty-cycle limit',
  BAD_REQUEST: 'bad request', NOT_AUTHORIZED: 'not authorised', PKI_FAILED: 'encryption failed', PKI_UNKNOWN_PUBKEY: "doesn't know the sender's key",
  ADMIN_BAD_SESSION_KEY: 'admin session expired', ADMIN_PUBLIC_KEY_UNAUTHORIZED: 'admin key not authorised', RATE_LIMIT_EXCEEDED: 'rate limited',
  PKI_SEND_FAIL_PUBLIC_KEY: "no key for the recipient",
}
export const routingError = (e?: string) => (e ? ROUTING_ERROR[e] ?? e.toLowerCase().replaceAll('_', ' ') : 'error')

const SIG_LABEL: Record<string, string> = { verified: 'signature verified', unsigned: 'unsigned', unverifiable: 'signed, key unknown', 'not-applicable': 'not signable' }
const SIG_SHORT: Record<string, string> = { verified: '✓', unsigned: '–', unverifiable: '?', 'not-applicable': 'n/a' }

function SigBadge({ s, compact = false }: { s: string; compact?: boolean }) {
  return <span className={`sig sig-${s}`} title={compact ? SIG_LABEL[s] ?? s : undefined}>{(compact ? SIG_SHORT : SIG_LABEL)[s] ?? s}</span>
}

function fmt(v: number | undefined | null, unit: string, digits = 1) {
  return v === undefined || v === null ? '—' : `${v.toFixed(digits)} ${unit}`
}

/** A distance for people: metres below 1 km, else km with one decimal. */
const dist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`)

/** Firmware reports battery level 101 when on external power. */
const battery = (v: number | undefined) => (v === undefined || v === null ? '—' : v > 100 ? 'external power' : `${Math.round(v)} %`)

const METHOD: Record<string, string> = { weighted_centroid: 'weighted centre of the nodes that hear it', log_distance_wls: 'distances from signal strength' }
const QUALITY: Record<string, string> = { very_low: 'very rough', low: 'rough' }

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

/** "NARROW_FAST" -> "Narrow Fast" */
const presetName = (p: string) => p.toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')

/**
 * Region and LoRa preset. Region: the node's own map report if any, else
 * what its topics allow. Preset: the engine's inference (D-064), strongest
 * evidence first; a map report's preset counts only when confirmed.
 */
function radioSummary(r: Radio | undefined, name: (id: string) => string): { region: string; preset: string; presetNote: string } {
  const heard = r?.heard_as ?? []
  let region = 'unknown'
  if (r?.reported?.region) region = `${r.reported.region} (its own map report)`
  else {
    // One node has one region: keep only regions every topic it was heard on allows.
    const sets = heard.filter((h) => h.regions.length).map((h) => h.regions)
    if (sets.length) {
      const common = sets.reduce((acc, r) => acc.filter((x) => r.includes(x)))
      region = common.length
        ? `${common.join(' or ')} (from the MQTT topic${sets.length > 1 ? 's' : ''})`
        : `conflicting topics: ${[...new Set(sets.map((r) => r.join(' or ')))].join(' / ')}`
    }
  }
  const p = r?.preset
  const via = (p?.via ?? []).map(name).join(', ')
  const others = (n: number) => `${n} other node${n === 1 ? '' : 's'}`
  let preset = 'unknown'
  let presetNote = 'No evidence in the selected period: no confirmed map report, no default channel name, and no radio contact with a node that has either.'
  if (p?.basis === 'conflict') {
    preset = `conflicting: ${(p.conflict ?? []).map(([q, n]) => `${presetName(q)} (${n})`).join(', ')}`
    presetNote = 'Nodes it shares radio contact with report different confirmed presets. Nodes that hear each other must share radio settings, so one of the links or reports is misleading (for example a downlinked packet that looked like a direct reception).'
  } else if (p?.preset) {
    const q = presetName(p.preset)
    if (p.basis === 'map_report') {
      preset = `${q} (its own map report)`
      presetNote = 'Its own map report, confirmed by its default channel: firmware reports a preset as in use only then.'
    } else if (p.basis === 'radio_contact') {
      preset = `${q} (radio contact)`
      presetNote = `Nodes that hear each other must share radio settings. It heard or was heard by ${others(p.direct)} itself, and through them and their contacts it is in radio contact with ${others(p.group)} in all; confirmed map reports from ${via} in that group put it on ${q} (or identical custom settings).`
    } else if (p.basis === 'channel_name') {
      preset = `probably ${q} (channel name)`
      presetNote = `It was heard on a channel with ${q}'s default name. Only a hint: a secondary channel can carry that name on any preset.`
    } else {
      preset = `probably ${q} (radio contact, channel names)`
      presetNote = `It heard or was heard by ${others(p.direct)} itself, and through chains of radio contact shares radio settings with ${others(p.group)} in all, among them ${via}, heard on channels with ${q}'s default name. Only a hint: no confirmed map report in the group.`
    }
  }
  const rep = r?.reported
  // Firmware reports its stored preset even under a custom modem config.
  if (rep?.modem_preset && !rep.preset_confirmed) presetNote += ` Its map report says ${presetName(rep.modem_preset)}, but without a default channel that may be a stored preset under a custom modem config.`
  return { region, preset, presetNote }
}

export function NodePanel({ id, snapshot }: { id: string; snapshot: SnapshotView | undefined }) {
  const { data, isLoading, error } = useNodeDetail(id)
  const select = useStore((s) => s.select)
  const tab = useStore((s) => s.detailTab)
  const snapNode = (snapshot?.nodes ?? []).find((n) => n.id === id)
  const now = snapshot ? Date.parse(snapshot.meta.window.end) : Date.now()
  const names = useMemo(() => new Map((snapshot?.nodes ?? []).map((n) => [n.id, nodeName(n, n.id)])), [snapshot])
  const neighbours = useMemo(() => linkNeighbours(snapshot?.edges ?? [], id, names), [snapshot, id, names])
  const heardBy = useMemo(() => sortHearings(data?.heard_by ?? [], id, snapshot?.edges ?? [], names), [data, id, snapshot, names])
  const positioned = useMemo(() => new Set((snapshot?.nodes ?? []).filter((n) => n.position || n.estimate).map((n) => n.id)), [snapshot])
  const moved = useMemo(() => new Set((snapshot?.nodes ?? []).filter((n) => n.moved_at).map((n) => n.id)), [snapshot])
  if (isLoading) return <div className="panel">Loading {id}…</div>
  if (error) return <div className="panel">No data for {id} in the selected window.</div>
  if (!data) return null
  const d = data
  const est = snapNode?.estimate
  const pos = d.position // a stale one is never shown as its position (D-094)
  const env = d.environment_series ?? []
  const dev = d.telemetry_series ?? []
  const telemetryCount = dev.length + env.length
  const winStart = snapshot ? Date.parse(snapshot.meta.window.start) : Math.min(...[...dev, ...env].map((s) => Date.parse(s.at)))
  const winEnd = now
  // Latest reading of each quantity: one report may carry only some of them.
  const envLast = {
    at: env.at(-1)?.at ?? '',
    temp: env.findLast((e) => e.temp != null)?.temp,
    humidity: env.findLast((e) => e.humidity != null)?.humidity,
    pressure: env.findLast((e) => e.pressure != null)?.pressure,
  }
  const envRange = (k: 'temp') => {
    const v = env.map((e) => e[k]).filter((x): x is number => x != null)
    return v.length > 1 ? `${Math.min(...v).toFixed(1)} to ${Math.max(...v).toFixed(1)} °C` : ''
  }
  const radio = radioSummary(d.radio, (n) => names.get(n) ?? n)
  return (
    <div className="panel node-panel">
      <div className="node-title">
        <h2>{d.identity?.long_name || d.id}</h2>
        <ShareNode id={d.id} name={d.identity?.long_name || d.id} />
      </div>
      <p className="muted node-id">{d.id} · #{d.num}</p>
      <p className="node-tags">
        {isOnline(d, now)
          ? <span className="tag online" title="Heard within the last 3 hours of the selected period">● online</span>
          : <span className="tag offline" title="Not heard in the last 3 hours of the selected period">offline{d.last_seen ? ` · last heard ${relativeAge(d.last_seen, now)}` : ''}</span>}{' '}
        {d.status === 'referenced' && <span className="tag">referenced only — not directly observed</span>}
        {d.is_gateway &&
          (d.multi_uplink ? (
            <span className="tag gw" title="Uplinks every copy of a packet it hears, each with the last hop it came from, not only the first (a firmware option): its reports show more of the routes packets take">
              ⏫ MQTT gateway, every copy
            </span>
          ) : (
            <span className="tag gw" title="Uplinks the packets it hears to the MQTT broker (the first copy of each)">↑ MQTT gateway</span>
          ))}
        {d.mqtt_downlink && (
          <span className="tag gw" title={`Probably transmits packets it takes from the MQTT broker: ${d.mqtt_downlink.zero_snr} of ${d.mqtt_downlink.traceroutes} traceroutes reached it at exactly 0 dB, the reading a packet from MQTT gets`}>
            ↓ MQTT downlink (probable)
          </span>
        )}
      </p>
      {d.mqtt_opt_out && (
        <p className="opt-out-note">This node did not allow MQTT uplink, but some of its packets reached us through another gateway. Its name and NodeInfo are not stored.</p>
      )}
      <NodeHealth id={d.id} />
      <DetailTabs counts={{ links: neighbours.length, packets: d.packets }} />
      {tab === 'overview' && (
        <>
          <dl>
            <dt>Short name</dt><dd>{d.identity?.short_name || NR}</dd>
            <dt>Hardware</dt><dd>{d.identity?.hw_model || NR}</dd>
            <dt>Role</dt><dd>{d.identity?.role || NR}</dd>
            {(d.node_status ?? []).length > 0 && (
              <>
                <dt title="The status text the node broadcasts about itself (node status app, firmware 2.7.20 and later)">Status</dt>
                <dd>
                  <q className="node-status">{d.node_status![0].status}</q> <small className="muted">· {formatLocal(d.node_status![0].at)}</small>
                  {d.node_status!.length > 1 && (
                    <ul className="status-history">
                      {d.node_status!.slice(1).map((s) => <li key={s.at}><span className="muted">earlier:</span> {s.status} <small className="muted">· {formatLocal(s.at)}</small></li>)}
                    </ul>
                  )}
                </dd>
              </>
            )}
            <dt>Identity</dt>
            <dd>
              {!d.identity ? NR : d.identity.source === 'mapreport' ? (
                <span title="No NodeInfo from this node in the selected period: name, hardware and role come from the map report it sends to the MQTT broker itself">
                  from its own map report · {formatLocal(d.identity.observed_at)}
                </span>
              ) : (
                <><SigBadge s={d.identity.signature} /> {d.identity.has_public_key ? 'announces a public key' : 'no public key'} · {formatLocal(d.identity.observed_at)}</>
              )}
            </dd>
            <dt>Public key</dt>
            <dd><PublicKey key={d.id} id={d.id} optOut={d.mqtt_opt_out} /></dd>
            <dt>Position</dt>
            <dd>
              {d.stale_position && (
                <div className="stale-note" title="A reported position more than a day older than the newest data in the selected period may no longer be where the node is (D-094)">
                  Last reported position is stale: {formatLocal(d.stale_position.observed_at)}.{' '}
                  {est ? 'Estimated instead:' : 'No estimate could be made, so it is not on the map.'}
                </div>
              )}
              {pos ? (
                <>
                  {pos.lat.toFixed(5)}, {pos.lon.toFixed(5)}
                  {pos.alt !== undefined && pos.alt !== null && <> · {pos.alt} m above sea level</>}
                  <br />
                  <small>
                    {pos.source === 'mapreport' ? 'from map report · ' : ''}
                    {pos.precision_known
                      ? pos.precision_bits >= 32
                        ? 'full precision'
                        : <span title={`Shared with ${pos.precision_bits} precision bits: firmware reports the centre of a cell this size, so it is somewhere within this distance`}>± {dist(precisionErrorM(pos.precision_bits, pos.lat))}</span>
                      : 'precision unknown'} · <SigBadge s={pos.signature} /> · {formatLocal(pos.observed_at)}
                  </small>
                  {d.refined && (
                    <div className="refined" title="Its reports jump around one place: combined, they narrow down where it is. The map places it here (D-077).">
                      Narrowed to {d.refined.lat.toFixed(5)}, {d.refined.lon.toFixed(5)} ± {d.refined.radius_m < 1000 ? `${Math.round(d.refined.radius_m)} m` : `${(d.refined.radius_m / 1000).toFixed(1)} km`}
                      <br />
                      <small>
                        from {d.refined.agree} of {d.refined.reports} reports{d.refined.agree < d.refined.reports ? `; ${d.refined.reports - d.refined.agree} outlying ones set aside as noise` : ''}
                      </small>
                    </div>
                  )}
                </>
              ) : est ? (
                <span className="est-note">
                  Estimated location{d.stale_position ? '' : ' (not reported)'}: {est.lat.toFixed(3)}, {est.lon.toFixed(3)} ± {dist(est.uncertainty_radius_m)}
                  <br />
                  <small title="Anchors: nodes with a precise reported position that heard it directly. Samples: those receptions.">
                    {QUALITY[est.quality] ?? est.quality} estimate from the {METHOD[est.method] ?? est.method}: {est.anchor_count} anchors, {est.sample_count} receptions. {(est.reasons ?? []).join(' ')}
                  </small>
                </span>
              ) : (
                <>
                  {!d.stale_position && NR}
                  {snapNode?.estimate_note && <>{!d.stale_position && <br />}<small>No estimate: {snapNode.estimate_note}</small></>}
                </>
              )}
            </dd>
            {d.moved_at && (
              <>
                <dt title="It moved more than a few hundred metres beyond what its position precision explains (D-073)">Moving</dt>
                <dd>
                  last moved {formatLocal(d.moved_at)} · {d.track?.length ?? 0}{(d.track?.length ?? 0) >= 100 ? '+' : ''} reported places in the window{d.airborne && <> · <span className="tag">✈ airborne</span></>}
                  <br /><small className="muted">Its links count only evidence from after that move.</small>
                </dd>
              </>
            )}
            <dt title="First and last time anything from it, or uplinked by it as a gateway, reached the broker">Seen in window</dt>
            <dd>
              {d.first_seen ? `${formatLocal(d.first_seen)} → ${formatLocal(d.last_seen)} (${relativeAge(d.last_seen, now)})`
                : d.last_referenced ? <span title="Never heard itself: only named in others' NeighborInfo or traceroutes">named by others, last {formatLocal(d.last_referenced)} ({relativeAge(d.last_referenced, now)})</span> : NR}
            </dd>
            <dt>Traffic</dt>
            <dd>
              <span title="Distinct packets it sent that reached the broker">{d.packets} unique packets</span> ·{' '}
              <span title="Receptions of its packets by other gateways, over the air (one per gateway and copy)">{d.receptions - (d.own_uplinks ?? 0)} receptions by other gateways</span>
              {(d.own_uplinks ?? 0) > 0 && <span title="Its own packets it uplinked itself as a gateway, its map reports among them: not radio receptions"> · {d.own_uplinks} uplinked itself</span>}
              {d.is_gateway && <span title="Other nodes' packets it uplinked as a gateway"> · uplinked {d.gateway_receptions - (d.own_uplinks ?? 0)} of others'</span>}
            </dd>
          </dl>
        </>
      )}
      {tab === 'telemetry' && (
        <>
          <dl>
            <dt title="Its latest device telemetry report">Device (latest)</dt>
            <dd>
              {d.telemetry ? (
                <>
                  battery {battery(d.telemetry.battery)} · {fmt(d.telemetry.voltage, 'V', 2)}
                  <br />
                  <span title="Share of airtime busy with any traffic it can hear">channel use {fmt(d.telemetry.ch_util, '%')}</span> ·{' '}
                  <span title="Share of the last hour it spent transmitting itself">own airtime {fmt(d.telemetry.air_util, '%')}</span>
                  {d.telemetry.uptime != null && <> · <span title="Time since it last started">up {(d.telemetry.uptime / 86_400).toFixed(1)} days</span></>} · <small>{formatLocal(d.telemetry.observed_at)}</small>
                </>
              ) : NR}
            </dd>
            {env.length > 0 && (
              <>
                <dt title="Sensor readings it reports (environment telemetry). Enclosures in the sun, or the board's own heat, can push temperatures up.">Environment (latest)</dt>
                <dd>
                  {[
                    envLast.temp != null && `${envLast.temp.toFixed(1)} °C`,
                    envLast.humidity != null && `${Math.round(envLast.humidity)} % humidity`,
                    envLast.pressure != null && `${Math.round(envLast.pressure)} hPa`,
                  ].filter(Boolean).join(' · ')}
                  {env.length > 1 && envRange('temp') && <><br /><small className="muted">temperature {envRange('temp')} in the window</small></>}
                  {' '}<small>· {formatLocal(envLast.at)}</small>
                </dd>
              </>
            )}
          </dl>
          {telemetryCount === 0 ? (
            <p className="muted">No telemetry from this node in the selected period.</p>
          ) : (
            <div className="tcharts">
              <TimeChart label="Battery" unit="%" decimals={0} domain={[0, 100]} start={winStart} end={winEnd}
                points={dev.map((s) => [Date.parse(s.at), s.battery != null && s.battery <= 100 ? s.battery : null])}
                empty={dev.some((s) => s.battery != null && s.battery > 100) ? 'on external power' : undefined} />
              <TimeChart label="Voltage" unit="V" decimals={2} start={winStart} end={winEnd} points={dev.map((s) => [Date.parse(s.at), s.voltage ?? null])} />
              <TimeChart label="Channel utilisation" unit="%" start={winStart} end={winEnd} points={dev.map((s) => [Date.parse(s.at), s.ch_util ?? null])} />
              <TimeChart label="Own airtime" unit="%" decimals={2} start={winStart} end={winEnd} points={dev.map((s) => [Date.parse(s.at), s.air_util ?? null])} />
              <TimeChart label="Uptime" unit="days" decimals={1} start={winStart} end={winEnd} points={dev.map((s) => [Date.parse(s.at), s.uptime != null ? s.uptime / 86_400 : null])} />
              <TimeChart label="Temperature" unit="°C" start={winStart} end={winEnd} points={env.map((s) => [Date.parse(s.at), s.temp ?? null])} />
              <TimeChart label="Humidity" unit="%" decimals={0} domain={[0, 100]} start={winStart} end={winEnd} points={env.map((s) => [Date.parse(s.at), s.humidity ?? null])} />
              <TimeChart label="Pressure" unit="hPa" decimals={0} start={winStart} end={winEnd} points={env.map((s) => [Date.parse(s.at), s.pressure ?? null])} />
            </div>
          )}
          {d.truncated && <p className="muted small">Long series are thinned to their first 500 reports.</p>}
        </>
      )}
      {tab === 'links' && (
        <>
          <h3 title="Every link in the window, whatever the map's filters hide; links to nodes without a position and guessed links included">Links in window ({neighbours.length})</h3>
          <ul className="links">
            {neighbours.map((g) => {
              const dir = (e: Edge | undefined, arrow: string, heard: string) => (
                <span className={`link-dir${e ? '' : ' muted'}`} title={heard}>
                  {arrow}{' '}
                  {!e ? 'no evidence' : e.mqtt ? <span className="conf conf-mqtt" title="Over the internet through an MQTT broker, not radio">Internet</span> : <span className={`conf conf-${e.confidence}`} title={e.reason}>{e.confidence}</span>}
                  {e?.snr.median != null && <small title="Median SNR measured at the receiving end, from all evidence for this direction"> SNR {e.snr.median.toFixed(1)} dB</small>}
                </span>
              )
              const name = names.get(g.peer) ?? g.peer
              const self = names.get(id) ?? id
              return (
                <li key={g.peer + (g.mqtt ? 'm' : '')}>
                  <button onClick={() => select({ kind: 'edge', src: id, dst: g.peer, mqtt: g.mqtt })}>
                    <span className="link-peer" title={name}>{name}</span>
                    {dir(g.out, '→', g.mqtt ? `${name} got packets ${self} passed on from an MQTT broker, not over the air` : `${name} heard ${self}`)}
                    {dir(g.in, '←', g.mqtt ? `${self} got packets ${name} passed on from an MQTT broker, not over the air` : `${self} heard ${name}`)}
                  </button>
                </li>
              )
            })}
          </ul>
          <h3 title="Gateways that uplinked its packets, directly or after relays">Uplinked by gateways ({(d.heard_by ?? []).length})</h3>
          <table className="hear">
            <thead><tr><th>Gateway</th><th title="The radio link from this node to the gateway: its confidence, or — when the gateway only got relayed copies (or its links were reset by a move)">Link</th><th title="Receptions of its packets by this gateway, relayed ones included">Rx</th><th title="Of those, heard directly (no relay in between)">Direct</th><th title="Median SNR of the direct receptions only: a relayed copy's SNR measures the last relay, not this node">SNR med</th><th title="Median RSSI of the direct receptions only">RSSI med</th></tr></thead>
            <tbody>
              {heardBy.slice(0, 30).map(({ h, link }) => (
                <tr key={h.node}>
                  <td>{names.get(h.node) ?? h.node}</td>
                  <td>{link ? <span className={`conf conf-${link.confidence}`} title={link.reason}>{link.confidence}</span> : <span className="muted" title="No radio link: only relayed copies, or its links were reset by a move">—</span>}</td>
                  <td>{h.receptions}</td><td>{h.direct_rf}</td><td>{fmt(h.snr.median, 'dB')}</td><td>{fmt(h.rssi.median, 'dBm', 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <RelayingSection node={snapNode} snapshot={snapshot} />
          <ReachSection key={d.id} id={d.id} name={(n) => names.get(n) ?? n} />
        </>
      )}
      {tab === 'radio' && (
        <>
          <dl>
            <dt>Region</dt><dd>{radio.region}</dd>
            <dt>LoRa preset</dt><dd title={radio.presetNote}>{radio.preset}</dd>
            <dt>Channels</dt>
            <dd>
              {d.radio?.channels?.length
                ? d.radio.channels.map((c, k) => (
                    <span key={c.name} title={[c.primary && 'Its primary channel (its own map report).', c.sent && `${c.sent} of its packets uplinked on it.`, c.uplinked && `Uplinked ${c.uplinked} receptions on it as a gateway.`].filter(Boolean).join(' ')}>
                      {k > 0 && ', '}{c.name}{c.primary && ' (primary)'}
                    </span>
                  ))
                : NR}
            </dd>
            <dt>Brokers</dt><dd>{d.brokers?.length ? d.brokers.join(', ') : NR}</dd>
            {d.is_gateway && (
              <>
                <dt title="The topic root this gateway publishes under, from the topics of the packets it uplinked in the selected period">MQTT root topic</dt>
                <dd>
                  {!d.radio.uplink_topics?.length
                    ? NR
                    : d.radio.uplink_topics.map((t, k) => (
                        <div key={t.topic} title={`Regions: ${t.regions.join(' or ') || 'unknown'} · last ${formatLocal(t.last_at)}`}>
                          <code className="topic">{t.topic}</code>
                          {d.radio.uplink_topics!.length > 1 && <small className="muted"> · {t.receptions} uplinks{k === 0 ? ' (most)' : ''}</small>}
                        </div>
                      ))}
                </dd>
              </>
            )}
          </dl>
          {(d.radio?.heard_as ?? []).length > 0 && (
            <>
              <h3 title="Each gateway uplinks with its own topic and channel name, so one node can be heard several ways">Heard on ({d.radio.heard_as.length})</h3>
              <table className="hear pkt-log" aria-label="Heard on">
                <colgroup><col /><col style={{ width: 90 }} /><col style={{ width: 88 }} /><col style={{ width: 34 }} /></colgroup>
                <thead><tr><th>MQTT topic</th><th>Channel</th><th>Preset</th><th>Rx</th></tr></thead>
                <tbody>
                  {d.radio.heard_as.map((h) => (
                    <tr key={h.topic + h.channel} title={`Regions: ${h.regions.join(' or ') || 'unknown'} · last ${formatLocal(h.last_at)}`}>
                      <td>{h.topic}</td><td>{h.channel ?? ''}</td><td>{h.preset ? presetName(h.preset) : 'unknown'}</td><td>{h.receptions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
      {tab === 'packets' && (
        <>
          <dl>
            <NodeAirtimeRow id={d.id} />
            {d.delivery && (
              <>
                <dt title="Routing packets: the ACKs and errors nodes send back for packets that asked for confirmation, or that could not be delivered or processed">Delivery reports</dt>
                <dd>
                  <DeliveryList label="sent" acks={d.delivery.acks_sent} errors={d.delivery.errors_sent} />
                  <br />
                  <DeliveryList label="received" acks={d.delivery.acks_received} errors={d.delivery.errors_received} />
                </dd>
              </>
            )}
            <dt>Signatures</dt>
            <dd title="One status per packet, its best copy's: relays can strip a signature, so a packet some gateway verified counts as verified">
              {d.signatures.verified} verified · {d.signatures.unsigned} unsigned · {d.signatures.unverifiable} signed, key unknown · {d.signatures.not_applicable} not signable
            </dd>
          </dl>
          {(d.delivery_by_recipient ?? []).length > 0 && (
            <>
              <h3 title="Its direct packets that asked for an acknowledgement, and the ACKs, replies and errors that came back">Delivery by recipient</h3>
              <table className="hear">
                <thead><tr><th>To</th><th title="Packets that asked for an ACK">Asked</th><th title="Confirmed by an ACK, or by the recipient's reply (a traceroute is answered with its reply)">Confirmed</th><th title="Answered with an error instead">Errors</th><th title="ACKed only after the sender retried">Retried</th></tr></thead>
                <tbody>
                  {d.delivery_by_recipient!.map((p) => (
                    <tr key={p.to}>
                      <td><button className="linkish" onClick={() => select({ kind: 'node', id: p.to })}>{names.get(p.to) ?? p.to}</button></td>
                      <td>{p.asked}</td>
                      <td>{p.acked} <small className="muted">({Math.round((p.acked / p.asked) * 100)} %)</small></td>
                      <td className={p.errors ? 'reply-err' : undefined}>{p.errors || ''}</td>
                      <td>{p.retried || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">Only what reached a gateway counts: a packet or its ACK no gateway heard is missing here, so a blank never means lost.</p>
            </>
          )}
          <PacketLogs id={id} names={names} positioned={positioned} moved={moved} />
          <p className="muted">Message contents are never stored or shown.</p>
        </>
      )}
    </div>
  )
}

const TABS: { id: DetailTab; label: string; hint: string }[] = [
  { id: 'overview', label: 'Overview', hint: 'Identity, position, activity and telemetry' },
  { id: 'links', label: 'Links', hint: 'Radio links, gateways that heard it, reach and relaying' },
  { id: 'radio', label: 'Radio', hint: 'Region, preset, channels, MQTT topics and brokers' },
  { id: 'telemetry', label: 'Telemetry', hint: 'Battery, power, channel use and sensor readings, charted over the selected period' },
  { id: 'packets', label: 'Packets', hint: 'Packet log, delivery reports, airtime and signatures' },
]

/** The node panel's tabs (D-098); the choice is kept when another node is selected. */
function DetailTabs({ counts }: { counts: Partial<Record<DetailTab, number>> }) {
  const tab = useStore((s) => s.detailTab)
  const setTab = useStore((s) => s.setDetailTab)
  const onKey = (e: React.KeyboardEvent) => {
    const k = TABS.findIndex((t) => t.id === tab)
    const next = e.key === 'ArrowRight' ? k + 1 : e.key === 'ArrowLeft' ? k - 1 : -2
    if (next === -2) return
    e.preventDefault()
    const t = TABS[(next + TABS.length) % TABS.length]
    setTab(t.id)
    document.getElementById(`detail-tab-${t.id}`)?.focus()
  }
  return (
    <div className="detail-tabs" role="tablist" aria-label="Node details" onKeyDown={onKey}>
      <span className="tab-edge" aria-hidden />
      {TABS.map((t, k) => (
        <Fragment key={t.id}>
          {k > 0 && <span className="tab-gap" aria-hidden />}
          <button id={`detail-tab-${t.id}`} role="tab" aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} title={t.hint} onClick={() => setTab(t.id)}>
            {t.label}{counts[t.id] !== undefined && <span className="tab-count">{counts[t.id]}</span>}
          </button>
        </Fragment>
      ))}
      <span className="tab-edge end" aria-hidden />
    </div>
  )
}

function DeliveryList({ label, acks, errors }: { label: string; acks: number; errors: [string, number][] }) {
  return (
    <>
      {label}: {acks} ACK{acks === 1 ? '' : 's'}
      {errors.map(([e, n]) => (
        <span key={e} title={e}> · <span className="reply-err">{n} × {routingError(e)}</span></span>
      ))}
    </>
  )
}

/** A routing packet's verdict, short: ✓ ACK or ✗ reason. */
function AnswerTag({ a }: { a: { kind: string; error?: string } }) {
  return a.kind === 'ack' ? <span className="reply-ok">✓ ACK</span> : <span className="reply-err" title={a.error}>✗ {routingError(a.error)}</span>
}

/** The selected node's packets in the window: its own, others' it relayed, and routing packets and direct messages addressed to it. */
function PacketLogs({ id, names, positioned, moved }: { id: string; names: Map<string, string>; positioned: Set<string>; moved: Set<string> }) {
  const select = useStore((s) => s.select)
  const route = useStore((s) => s.route)
  const showRoute = useStore((s) => s.showRoute)
  const [withRelayed, setWithRelayed] = useState(false)
  const log = usePacketLog(id)
  const [shown, setShown] = useState({ own: 50, relayed: 50 })
  const more = (k: 'own' | 'relayed', total: number) =>
    total > shown[k] && <button className="more" onClick={() => setShown((s) => ({ ...s, [k]: s[k] + 100 }))}>Show more ({total - shown[k]} hidden)</button>
  const own = log.data?.own ?? []
  const relayed = log.data?.relayed ?? []
  const nm = (n: string) => names.get(n) ?? n
  const how = {
    relay_byte: ['byte', "A gateway's last-hop byte resolved to this node"],
    traceroute: ['route', "This node is in the traceroute's recorded route"],
  } as const
  type Entry = { lp: string; at: string; type: string; to?: string; gateways: number } & (
    | { kind: 'own'; hops?: number; signature: string; by_itself?: boolean; downlinked?: boolean; replies?: Reply[]; answers?: Answer; invalid?: string }
    | { kind: 'relayed'; origin: string; evidence: ('relay_byte' | 'traceroute')[] }
    | { kind: 'inbound'; origin: string; answers?: Answer }
  )
  // Newest first; times parsed once per log, not inside the comparator on every render.
  const data = log.data
  const entries = useMemo(() => {
    const all: Entry[] = [
      ...(data?.own ?? []).map((p) => ({ ...p, kind: 'own' as const })),
      ...(withRelayed ? (data?.relayed ?? []).map((p) => ({ ...p, kind: 'relayed' as const, gateways: p.gateways.length })) : []),
      ...(data?.inbound ?? []).map((p) => ({ ...p, kind: 'inbound' as const, to: id, gateways: 0 })),
    ]
    const ms = new Map(all.map((e) => [e, Date.parse(e.at)]))
    return all.sort((a, b) => ms.get(b)! - ms.get(a)!)
  }, [data, withRelayed, id])
  return (
    <>
      <div className="log-head">
        <h3>Packet log ({own.length + (withRelayed ? relayed.length : 0) + (log.data?.inbound.length ?? 0)}{log.data?.truncated ? '+' : ''})</h3>
        <label title="Other nodes' packets this node passed on: a gateway's last-hop byte resolved to it, or it is in a traceroute's recorded route">
          <input type="checkbox" checked={withRelayed} onChange={(e) => setWithRelayed(e.target.checked)} /> Include relayed ({relayed.length}{log.data?.truncated && relayed.length >= 200 ? '+' : ''})
        </label>
      </div>
      {log.isLoading && <p className="muted">Loading…</p>}
      <RouteNote positioned={positioned} moved={moved} name={(n) => names.get(n) ?? n} />
      <p className="muted small">Select a packet to draw its route on the map.</p>
      <table className="hear pkt-log" aria-label="Packet log">
        <colgroup><col style={{ width: 60 }} /><col /><col style={{ width: 92 }} /><col /><col style={{ width: 70 }} /><col style={{ width: 30 }} /><col style={{ width: 34 }} /></colgroup>
        <thead><tr><th>Time</th><th>From</th><th>Type</th><th>To</th><th title="Own packets: the fewest hops another gateway's copy shows (hop start minus hop limit; relays over 0-cost links spend none, so it can be fewer than the relays). 'self': only it uplinked it. 'MQTT': a copy came through an MQTT downlink. Relayed: how we know this node passed it on">Hops</th><th title="Other gateways that uplinked it (relayed: that heard this node's rebroadcast)">GWs</th><th title="Delivery reports: ✓ an ACK or ✗ an error answered this packet. Only reports that reached a gateway are known, so a blank never means it was lost. For a routing packet, ↩ selects the packet it answers">Re</th></tr></thead>
        <tbody>
          {entries.slice(0, shown.own).map((p) => (
            <tr key={p.kind + p.lp} data-kind={p.kind} className={route === p.lp ? 'active' : undefined} onClick={() => showRoute(route === p.lp ? null : p.lp)} aria-selected={route === p.lp}>
              <td title={formatLocal(p.at)}>{formatLogTime(p.at)}</td>
              <td className="wrap" title={p.kind === 'relayed' ? nm(p.origin) : undefined}>
                {p.kind === 'own' ? <span className="ev-tag own">own</span> : (
                  <button className="linkish" onClick={(e) => { e.stopPropagation(); select({ kind: 'node', id: p.origin }) }}>{nm(p.origin)}</button>
                )}
              </td>
              <td title={(TYPE_TIP[p.type] ?? p.type) + (p.kind === 'own' && p.invalid ? `: ${INVALID[p.invalid] ?? p.invalid}` : '') + (p.kind === 'own' && p.type !== 'invalid' ? ` · ${SIG_LABEL[p.signature] ?? p.signature}` : '') + (p.kind !== 'relayed' && p.answers ? (p.answers.kind === 'ack' && p.kind === 'own' && p.to ? ` · confirms it received ${nm(p.to)}'s packet ${p.answers.request_id}` : ` · answers packet ${p.answers.request_id}`) : '')}>
                {p.kind !== 'relayed' && p.answers ? <AnswerTag a={p.answers} /> : p.type === 'invalid' ? <span className="reply-err">invalid</span> : TYPE_SHORT[p.type] ?? p.type}
              </td>
              <td className="wrap" title={p.to && p.to !== 'broadcast' ? nm(p.to) : undefined}>{p.to === 'broadcast' ? 'all' : p.to ? nm(p.to) : ''}</td>
              <td>
                {p.kind === 'own'
                  ? <>
                      {p.hops !== undefined ? `${p.hops}` : p.by_itself ? <span className="muted" title="Only it uplinked this packet itself">self</span> : ''}
                      {p.downlinked && <span className="ev-tag" title="A copy reached a gateway through an MQTT downlink: flagged via MQTT, taken from the broker and transmitted with no hops left, so it carries no hop count"> MQTT</span>}
                    </>
                  : p.kind === 'relayed' ? p.evidence.map((e) => <span key={e} className="ev-tag" title={how[e][1]}>{how[e][0]}</span>) : <span className="muted" title="Addressed to this node">to it</span>}
              </td>
              <td>{p.gateways || ''}</td>
              <td>
                {p.kind === 'own' && p.replies?.length ? (
                  <span title={p.replies.map((r) => `${r.kind === 'ack' ? 'ACK' : routingError(r.error)} from ${nm(r.from)}${r.count > 1 ? ` ×${r.count}` : ''}`).join('\n')}>
                    {p.replies.some((r) => r.kind !== 'ack') ? <span className="reply-err">✗</span> : <span className="reply-ok">✓</span>}
                  </span>
                ) : p.kind !== 'relayed' && p.answers?.re ? (
                  <button className="linkish" title="Draw the route of the packet this answers" onClick={(e) => { e.stopPropagation(); showRoute(p.answers!.re!) }}>↩</button>
                ) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {more('own', entries.length)}
    </>
  )
}

/** What the drawn route shows, and what it cannot. */
function RouteNote({ positioned, moved, name }: { positioned: Set<string>; moved: Set<string>; name: (id: string) => string }) {
  const lp = useStore((s) => s.route)
  const showRoute = useStore((s) => s.showRoute)
  const r = usePacketRoute(lp)
  if (!lp) return null
  const segs = r.data?.segments ?? []
  const dashed = segs.filter((g) => g.dashed).length
  const nodes = [...new Set(segs.flatMap((g) => [g.a, g.b]))]
  const unplaced = nodes.filter((n) => !positioned.has(n))
  const movers = nodes.filter((n) => moved.has(n))
  return (
    <p className="route-note">
      Route on the map: {segs.length} segment{segs.length === 1 ? '' : 's'}{dashed ? `, ${dashed} dashed (nodes missing)` : ''}
      {unplaced.length ? `; ${unplaced.map(name).join(', ')} ${unplaced.length === 1 ? 'has' : 'have'} no position, so the route is dashed across ${unplaced.length === 1 ? 'it' : 'them'}` : ''}.
      {r.data?.delivered?.length ? ` Delivery confirmed by ${r.data.delivered.map(name).join(', ')} (ACK; dashed green where the path is not known).` : ''}
      {movers.length > 0 && ` ${movers.map(name).join(', ')} moved during the window: drawn where ${movers.length === 1 ? 'it was' : 'they were'} when this packet was heard (ring), dashed to where ${movers.length === 1 ? 'it is' : 'they are'} now.`} Links are hidden meanwhile.{' '}
      <button className="linkish" onClick={() => showRoute(null)}>Clear route</button>
    </p>
  )
}

export function EdgePanel({ a, b, mqtt = false, snapshot }: { a: string; b: string; mqtt?: boolean; snapshot: SnapshotView | undefined }) {
  const select = useStore((s) => s.select)
  const names = new Map((snapshot?.nodes ?? []).map((n) => [n.id, nodeName(n, n.id)]))
  const name = (id: string) => names.get(id) ?? id
  const find = (src: string, dst: string) => (snapshot?.edges ?? []).find((e) => e.src === src && e.dst === dst && !!e.mqtt === mqtt)
  const stats = (e: Edge) => (
    <dl>
      <dt>Evidence</dt>
      <dd>
        <span title="NeighborInfo reports listing this neighbour (one per packet)">NeighborInfo {e.evidence.neighbor}</span> ·{' '}
        <span title="Traceroute hops (a reply repeating its request's hops counts once)">traceroute {e.evidence.traceroute}</span> ·{' '}
        <span title="Zero-hop receptions by the gateway (one per reception)">heard directly {e.evidence.direct_rf}</span> ·{' '}
        <span title="Relayed copies whose last-hop byte matched only this node: they point at the link without observing it">guessed from relay byte {e.evidence.relay_hint}</span>
      </dd>
      {e.mqtt ? (
        <><dt>Why internet</dt><dd><span className="conf conf-mqtt">Internet</span> {e.reason}</dd></>
      ) : (
        <><dt title="High: observed 3 or more times, or in more than one way. Medium: observed once or twice. Low: only guessed from relay bytes.">Confidence</dt><dd><span className={`conf conf-${e.confidence}`}>{e.confidence}</span> — {e.reason}</dd></>
      )}
      {e.mqtt ? (
        <><dt>Signal</dt><dd>none: not received over radio</dd></>
      ) : (
        <>
          <dt title="Measured by the receiving node: by the gateway for direct receptions, by the next hop for traceroutes and NeighborInfo">SNR at receiver</dt><dd>{e.snr.n ? `median ${e.snr.median?.toFixed(1)} dB (min ${e.snr.min}, max ${e.snr.max}, last ${e.snr.last}; ${e.snr.n} readings)` : '—'}</dd>
          <dt>RSSI at receiver</dt><dd>{e.rssi.n ? `median ${e.rssi.median} dBm (min ${e.rssi.min}, max ${e.rssi.max}, last ${e.rssi.last}; ${e.rssi.n} readings)` : 'only measured by gateway receptions'}</dd>
        </>
      )}
      <dt>In window</dt><dd>{formatLocal(e.first_at)} → {formatLocal(e.last_at)}</dd>
      {e.zero_cost && (
        <>
          <dt title="Firmware lets a ROUTER, ROUTER_LATE or CLIENT_BASE relay what it hears from a node it has marked as a favourite (itself one of those roles) without spending a hop: 0-cost. Found from the hop limits gateways saw before and after this hop.">0-cost</dt>
          <dd>
            {e.zero_cost.likely ? <span className="conf conf-zero">0-cost</span> : 'not established'}{' '}
            {name(e.dst)} relayed {e.zero_cost.free} packet{e.zero_cost.free === 1 ? '' : 's'} from {name(e.src)} without spending a hop{e.zero_cost.spent ? `, and spent one on ${e.zero_cost.spent}` : ''}.
          </dd>
        </>
      )}
    </dl>
  )
  const direction = (src: string, dst: string) => {
    const e = find(src, dst)
    return (
      <section className="direction">
        <h3>{name(src)} → {name(dst)}</h3>
        {e ? <><p className="muted">{mqtt ? `${name(dst)} got packets ${name(src)} passed on, from an MQTT broker rather than over the air.` : `${name(dst)} heard ${name(src)}.`}</p>{stats(e)}</>
          : <p className="muted">{mqtt ? `No traceroute shows ${name(dst)} getting packets from ${name(src)} through an MQTT broker in this window.` : `No evidence that ${name(dst)} heard ${name(src)} in this window.`}</p>}
      </section>
    )
  }
  return (
    <div className="panel">
      <h2>{mqtt ? 'Internet link' : 'Link'}</h2>
      <p>
        <button className="linkish" onClick={() => select({ kind: 'node', id: a })}>{name(a)}</button> ↔{' '}
        <button className="linkish" onClick={() => select({ kind: 'node', id: b })}>{name(b)}</button>
      </p>
      {mqtt ? (
        <p className="muted">
          Not a radio link: the packet crossed the internet through an MQTT broker. Traceroutes recorded these hops at exactly 0 dB, the reading a packet gets when the receiving node takes it from an MQTT broker (downlink) instead of hearing it over the air.
          They are kept out of the radio links, link statistics and position estimates.
        </p>
      ) : (
        <p className="muted">One line on the map per pair. Radio links can be asymmetric, so each direction is measured separately below.</p>
      )}
      {direction(a, b)}
      {direction(b, a)}
      {!mqtt && snapshot && <LinkHistoryCharts a={a} b={b} name={name} start={Date.parse(snapshot.meta.window.start)} end={Date.parse(snapshot.meta.window.end)} />}
    </div>
  )
}

const EV_LABEL: Record<string, string> = { neighbor: 'NeighborInfo', traceroute: 'traceroute', direct_rf: 'heard directly', relay_hint: 'relay guess' }

/** The link's signal over the selected period, both directions (D-105). */
function LinkHistoryCharts({ a, b, name, start, end }: { a: string; b: string; name: (id: string) => string; start: number; end: number }) {
  const h = useLinkHistory(a, b)
  if (!h.data) return null
  const { ab, ba } = h.data
  if (ab.length + ba.length === 0) return null
  const series = (k: 'snr' | 'rssi') => [
    { label: `${name(a)} → ${name(b)}`, color: 'var(--accent)', points: ab.map((p) => [p.t, p[k] ?? null] as [number, number | null]) },
    { label: `${name(b)} → ${name(a)}`, color: 'var(--warn)', points: ba.map((p) => [p.t, p[k] ?? null] as [number, number | null]) },
  ]
  const kinds = [...new Set([...ab, ...ba].map((p) => EV_LABEL[p.ev] ?? p.ev))]
  return (
    <section className="link-history">
      <h3 title="Every measured reading of this link in the selected period, each RF event once">Signal over time</h3>
      <p className="muted small">Each reading as the receiving node measured it ({kinds.join(', ')}). A falling line across days can mean a degrading antenna, cable or site; short dips are often weather or traffic.</p>
      <div className="tcharts">
        <TimeChart label="SNR" unit="dB" start={start} end={end} series={series('snr')} />
        <TimeChart label="RSSI" unit="dBm" decimals={0} start={start} end={end} series={series('rssi')} empty="only measured by gateway receptions" />
      </div>
    </section>
  )
}

const MAX_HOPS = 7

/**
 * Reach simulator (D-069): how many nodes the selected node's packets reach
 * at each hop limit, from the links seen in the window, 0-cost links
 * included (D-068). Optionally drawn on the map instead of the links.
 */
function ReachSection({ id, name }: { id: string; name: (id: string) => string }) {
  const shown = useStore((s) => s.reach)
  const setReach = useStore((s) => s.setReach)
  const [internet, setInternet] = useState(false)
  const q = useReach(id, internet)
  const r = q.data?.origin === id ? q.data : undefined
  const [hops, setHops] = useState<number | null>(null)
  const h = hops ?? r?.hop_start ?? 3
  const ramp = PALETTES[useTheme()].reach
  // Keep the map in step while it is shown.
  useEffect(() => {
    if (shown && (shown.hops !== h || shown.internet !== internet)) setReach({ hops: h, internet })
  }, [h, internet, shown, setReach])
  const per = Array.from({ length: MAX_HOPS + 1 }, (_, k) => (r?.nodes ?? []).filter((n) => n.need === k).length)
  const total = per.slice(0, h + 1).reduce((a, b) => a + b, 0)
  const all = per.reduce((a, b) => a + b, 0)
  const free = (r?.nodes ?? []).filter((n) => n.free && n.need <= h).length
  return (
    <section className="reach">
      <h3 title="How far this node's packets get at each hop limit, following the radio links seen in the selected period">Reach</h3>
      <label className="reach-slider">
        <span>Max hops</span>
        <input type="range" min={0} max={MAX_HOPS} step={1} value={h} aria-label="Max hops" onChange={(e) => setHops(+e.target.value)} />
        <b>{h}</b>
      </label>
      <p className="muted reach-note">
        {r?.hop_start !== undefined ? <>Its packets use {r.hop_start}. </> : null}
        {q.isLoading ? 'Working it out…' : <>Reaches <b>{total}</b> node{total === 1 ? '' : 's'} at {h} hop{h === 1 ? '' : 's'}{all > total ? ` (${all} at ${MAX_HOPS})` : ''}.{free ? ` ${free} of them through 0-cost links.` : ''}</>}
      </p>
      <div className="reach-steps" role="list" aria-label="Nodes added at each hop limit">
        {per.map((n, k) => (
          <button key={k} role="listitem" className={k <= h ? 'on' : undefined} onClick={() => setHops(k)} title={`${n} node${n === 1 ? '' : 's'} need a hop limit of ${k}`}>
            <span className="swatch" style={{ background: `rgb(${ramp[k].join(',')})` }} />
            <span className="k">{k}</span>
            <span className="n">{k === 0 ? n : `+${n}`}</span>
          </button>
        ))}
      </div>
      <label><input type="checkbox" checked={!!shown} onChange={(e) => setReach(e.target.checked ? { hops: h, internet } : null)} /> Show on the map</label>
      <label title="Follow internet (MQTT) links too: packets a gateway uplinked and another node downlinked and transmitted">
        <input type="checkbox" checked={internet} onChange={(e) => setInternet(e.target.checked)} /> Count internet links
      </label>
      <p className="muted reach-caveat">
        Built from the radio links seen in the selected period, in the direction they were heard; each relay spends a hop unless it
        relays for free over a 0-cost link (gold chevrons). Dashed lines skip relays that have no position on the map. Links never observed are missing, and intermittent ones count as always there.
        {r && r.nodes.length > 0 && shown && <> Nearest relays: {[...new Set(r.nodes.filter((n) => n.need === 1).map((n) => n.via))].slice(0, 3).map(name).join(', ')}.</>}
      </p>
    </section>
  )
}

/** Below this many expected packets the share says too little to show. */
const MIN_EXPECTED = 10
const pct = (seen: number, expected: number) => Math.round((100 * seen) / expected)

/**
 * Routers: how often they are seen relaying what they should relay (D-078),
 * against the median of routers with the same role.
 */
function RelayingSection({ node, snapshot }: { node: MeshNode | undefined; snapshot: SnapshotView | undefined }) {
  const r = node?.relaying
  const role = node?.identity?.role
  const peers = useMemo(() => {
    const shares = (snapshot?.nodes ?? [])
      .filter((n) => n.identity?.role === role && n.relaying && n.relaying.expected >= MIN_EXPECTED)
      .map((n) => n.relaying!.seen / n.relaying!.expected)
      .sort((a, b) => a - b)
    return shares.length >= 3 ? { median: Math.round(100 * shares[Math.floor(shares.length / 2)]), count: shares.length } : null
  }, [snapshot, role])
  if (!r) return null
  return (
    <section className="relaying">
      <h3 title="A ROUTER or ROUTER_LATE rebroadcasts every packet it receives with hops left. Counted only where a gateway that hears it (a witness) also got the packet.">Relaying</h3>
      {r.expected < MIN_EXPECTED ? (
        <p className="muted">Too few packets to judge: {r.expected} it probably received where a witness could have seen it relay them.</p>
      ) : r.received_as_gateway * 10 < r.expected ? (
        <p className="muted">
          Seen relaying {r.seen} of {r.expected} packets it probably received, but {r.expected - r.received_as_gateway} of those are only inferred from links to their senders (hearing a sender sometimes does not mean it got every packet), so no share is shown.
        </p>
      ) : (
        <>
          <p>
            Seen relaying <b>{r.seen}</b> of {r.expected} packets it probably received (<b>{pct(r.seen, r.expected)} %</b>)
            {peers && <> · {role} median {peers.median} % ({peers.count} routers)</>}
          </p>
          <p className="muted reach-caveat">
            A lower bound: {r.witnesses} gateway{r.witnesses === 1 ? '' : 's'} hear{r.witnesses === 1 ? 's' : ''} it directly, and a gateway uplinks only the first copy it hears, so its
            rebroadcast is unseen whenever another copy got there first{role === 'ROUTER_LATE' ? ' (likely for a ROUTER_LATE, which waits before relaying)' : ''}.
            {' '}{r.received_as_gateway === r.expected ? 'It uplinked every one of them itself, so it surely received them.' : `${r.expected - r.received_as_gateway} of them are inferred from a strong link to the sender rather than its own uplink.`}
            {' '}Compare with routers of the same role and coverage rather than reading it as an absolute.
          </p>
        </>
      )}
    </section>
  )
}

/**
 * A permanent link to the node (D-080): the node alone, so it keeps working
 * whatever window or filters the viewer had. The phone's share sheet when
 * there is one, otherwise copied to the clipboard.
 */
/** The node's public key from the whole retained log (keys identify a node, not a window). */
function PublicKey({ id, optOut }: { id: string; optOut?: boolean }) {
  const [k, setK] = useState<NodeKey | 'none' | 'error' | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const ctl = new AbortController()
    getJSON<NodeKey>(`/api/v1/nodes/${encodeURIComponent(id)}/public-key`, undefined, ctl.signal)
      .then(setK)
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setK(e instanceof ApiError && e.status === 404 ? 'none' : 'error')
      })
    return () => ctl.abort()
  }, [id])
  if (k === null) return <span className="muted">…</span>
  if (k === 'none')
    return optOut ? (
      <span className="muted" title="This node does not allow MQTT uplink, so its NodeInfo (which carries the key) is not stored when another gateway uplinks it">none retained (NodeInfo not stored)</span>
    ) : (
      <span className="muted" title="No NodeInfo carrying a public key from this node is retained">none retained</span>
    )
  if (k === 'error') return <span className="muted">unavailable</span>
  const key = k.public_key || k.trusted_key || ''
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(key)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      /* clipboard refused */
    }
  }
  const differs = !!k.trusted_key && !!k.public_key && k.trusted_key !== k.public_key
  return (
    <>
      <code className="pubkey">{key}</code>{' '}
      <button className="linkish" onClick={() => void copy()} title="Copy the key (base64)">{copied ? 'Copied' : 'Copy'}</button>
      <br />
      <small>
        {k.announced_at && <>announced {formatLocal(k.announced_at)}</>}
        {k.trusted_key && !differs && k.trusted_since && <span title="The first verified NodeInfo with this key: signatures from this node are checked against it (trust on first use)"> · trusted since {formatLocal(k.trusted_since)}</span>}
        {!k.trusted_key && <span title="No signed NodeInfo verified under this key is retained, so signatures from this node cannot be checked"> · not verified</span>}
      </small>
      {differs && (
        <p className="opt-out-note" title="Signatures are checked against the trusted key, so packets signed with the new one are not verified until the trusted key's NodeInfo ages out of retention">
          Differs from the key trusted since {formatLocal(k.trusted_since!)}: <code className="pubkey">{k.trusted_key}</code>
        </p>
      )}
    </>
  )
}

function ShareNode({ id, name }: { id: string; name: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const share = async () => {
    const url = nodeLink(id)
    try {
      if (navigator.share && window.matchMedia?.('(pointer: coarse)').matches) {
        await navigator.share({ title: `${name} on 868.no Map`, url })
        return
      }
      await navigator.clipboard.writeText(url)
      setState('copied')
    } catch (e) {
      if ((e as Error).name === 'AbortError') return // the share sheet was dismissed
      setState('failed')
    }
    setTimeout(() => setState('idle'), 2500)
  }
  return (
    <button className="linkish share-link" onClick={() => void share()} title={`Copy a permanent link to this node: ${nodeLink(id)}`}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Share'}
    </button>
  )
}


const CONF_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 }

/** A neighbour on the Links list: both directions of the link to it. */
export interface LinkNeighbour {
  peer: string
  mqtt: boolean
  out?: Edge // the neighbour heard this node
  in?: Edge // this node heard the neighbour
}

/**
 * The selected node's links grouped by neighbour (radio and internet links
 * apart), sorted by the better direction's confidence, then its median SNR
 * (strongest first), then name. Internet links follow the radio ones.
 */
export function linkNeighbours(edges: Edge[], id: string, names: Map<string, string>): LinkNeighbour[] {
  const groups = new Map<string, LinkNeighbour>()
  for (const e of edges) {
    if (e.src !== id && e.dst !== id) continue
    const peer = e.src === id ? e.dst : e.src
    const key = peer + (e.mqtt ? '|m' : '')
    const g = groups.get(key) ?? { peer, mqtt: !!e.mqtt }
    if (e.src === id) g.out = e
    else g.in = e
    groups.set(key, g)
  }
  const both = (g: LinkNeighbour) => [g.out, g.in].filter((e): e is Edge => !!e)
  const conf = (g: LinkNeighbour) => (g.mqtt ? 0 : Math.max(...both(g).map((e) => CONF_RANK[e.confidence] ?? 0)))
  const snr = (g: LinkNeighbour) => Math.max(...both(g).map((e) => e.snr.median ?? -999))
  return [...groups.values()].sort(
    (a, b) => conf(b) - conf(a) || snr(b) - snr(a) || (names.get(a.peer) ?? a.peer).localeCompare(names.get(b.peer) ?? b.peer),
  )
}

/**
 * Gateways that heard the node, sorted like the Links list: by the radio
 * link's confidence (none last: the gateway only got relayed copies), then
 * median SNR (strongest first), then name.
 */
export function sortHearings(heardBy: Hearing[], id: string, edges: Edge[], names: Map<string, string>): { h: Hearing; link?: Edge }[] {
  const links = new Map(edges.filter((e) => !e.mqtt && e.src === id).map((e) => [e.dst, e]))
  const rank = (x: { link?: Edge }) => (x.link ? CONF_RANK[x.link.confidence] ?? 0 : 0)
  const snr = (x: { h: Hearing }) => x.h.snr.median ?? -999
  const name = (x: { h: Hearing }) => names.get(x.h.node) ?? x.h.node
  return heardBy.map((h) => ({ h, link: links.get(h.node) })).sort((a, b) => rank(b) - rank(a) || snr(b) - snr(a) || name(a).localeCompare(name(b)))
}
