import { useEffect, useMemo, useState } from 'react'
import type { Edge, MeshNode, Radio, SnapshotView } from '../derive/views'
import { useNodeDetail, usePacketLog, usePacketRoute, useReach } from '../state/data'
import { useStore } from '../state/store'
import { formatLocal, formatLogTime, relativeAge } from '../lib/time'
import { Sparkline } from '../components/Sparkline'
import { ageColor, lastHeardAge } from '../map/model'
import { PALETTES } from '../map/palette'
import { useTheme } from '../theme'

const NR = <span className="nr">not reported in selected period</span>

function nodeName(n: MeshNode | undefined, id: string): string {
  return n?.identity?.long_name || n?.identity?.short_name || id
}

const SIG_LABEL: Record<string, string> = { verified: 'signature verified', unsigned: 'unsigned', unverifiable: 'signed, key unknown', 'not-applicable': 'not signable' }
const SIG_SHORT: Record<string, string> = { verified: '✓', unsigned: '–', unverifiable: '?', 'not-applicable': 'n/a' }

function SigBadge({ s, compact = false }: { s: string; compact?: boolean }) {
  return <span className={`sig sig-${s}`} title={compact ? SIG_LABEL[s] ?? s : undefined}>{(compact ? SIG_SHORT : SIG_LABEL)[s] ?? s}</span>
}

function fmt(v: number | undefined | null, unit: string, digits = 1) {
  return v === undefined || v === null ? '—' : `${v.toFixed(digits)} ${unit}`
}

export function NodeList({ snapshot }: { snapshot: SnapshotView | undefined }) {
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const select = useStore((s) => s.select)
  const nodes = snapshot?.nodes ?? []
  const q = search.trim().toLowerCase()
  const match = (n: MeshNode) =>
    !q || n.id.includes(q) || (n.identity?.long_name ?? '').toLowerCase().includes(q) || (n.identity?.short_name ?? '').toLowerCase().includes(q)
  const positioned = nodes.filter((n) => (n.position || n.estimate) && match(n))
  const unpositioned = nodes.filter((n) => !n.position && !n.estimate && match(n))
  const w = snapshot?.meta.window
  const endMs = w ? Date.parse(w.end) : 0, windowMs = w ? endMs - Date.parse(w.start) : 0
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
        <span className="id">{n.id}</span>
        <span className="ct" title="unique packets / receptions">{n.packets}/{n.receptions}</span>
      </button>
    </li>
  )
  return (
    <div className="panel">
      <input className="search" type="search" placeholder="Search in-window nodes (id or name)" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search nodes" />
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
      presetNote = `It shares radio settings with ${others(p.group)} it hears or is heard by, directly or through them; confirmed map reports from ${via} put that group on ${q} (or identical custom settings).`
    } else if (p.basis === 'channel_name') {
      preset = `probably ${q} (channel name)`
      presetNote = `It was heard on a channel with ${q}'s default name. Only a hint: a secondary channel can carry that name on any preset.`
    } else {
      preset = `probably ${q} (radio contact, channel names)`
      presetNote = `It shares radio settings with ${others(p.group)}, among them ${via}, heard on channels with ${q}'s default name. Only a hint: no confirmed map report in the group.`
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
  const snapNode = (snapshot?.nodes ?? []).find((n) => n.id === id)
  const now = snapshot ? Date.parse(snapshot.meta.window.end) : Date.now()
  const edges = useMemo(() => (snapshot?.edges ?? []).filter((e) => e.src === id || e.dst === id), [snapshot, id])
  const names = useMemo(() => new Map((snapshot?.nodes ?? []).map((n) => [n.id, nodeName(n, n.id)])), [snapshot])
  const positioned = useMemo(() => new Set((snapshot?.nodes ?? []).filter((n) => n.position || n.estimate).map((n) => n.id)), [snapshot])
  if (isLoading) return <div className="panel">Loading {id}…</div>
  if (error) return <div className="panel">No data for {id} in the selected window.</div>
  if (!data) return null
  const d = data
  const est = snapNode?.estimate
  const radio = radioSummary(d.radio, (n) => names.get(n) ?? n)
  return (
    <div className="panel node-panel">
      <h2>{d.identity?.long_name || d.id}</h2>
      <p className="muted">
        {d.id} · #{d.num} {d.status === 'referenced' && <span className="tag">referenced only — not directly observed</span>}
        {d.is_gateway && <span className="tag gw" title="Uplinks the packets it hears to the MQTT broker">↑ MQTT gateway</span>}
        {d.mqtt_downlink && (
          <span className="tag gw" title={`Probably transmits packets it takes from the MQTT broker: ${d.mqtt_downlink.zero_snr} of ${d.mqtt_downlink.traceroutes} traceroutes reached it at exactly 0 dB, the reading a packet from MQTT gets`}>
            ↓ MQTT downlink (probable)
          </span>
        )}
      </p>
      {d.mqtt_opt_out && (
        <p className="opt-out-note">This node did not allow MQTT uplink, but some of its packets reached us through another gateway. Its name and NodeInfo are not stored.</p>
      )}
      <dl>
        <dt>Short name</dt><dd>{d.identity?.short_name || NR}</dd>
        <dt>Hardware</dt><dd>{d.identity?.hw_model || NR}</dd>
        <dt>Role</dt><dd>{d.identity?.role || NR}</dd>
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
        <dt>Position</dt>
        <dd>
          {d.position ? (
            <>
              {d.position.lat.toFixed(5)}, {d.position.lon.toFixed(5)}
              {d.position.alt !== undefined && d.position.alt !== null && <> · {d.position.alt} m</>}
              <br />
              <small>
                {d.position.source === 'mapreport' ? 'from map report · ' : ''}{d.position.precision_known ? `${d.position.precision_bits} precision bits` : 'precision unknown'} · <SigBadge s={d.position.signature} /> · {formatLocal(d.position.observed_at)}
              </small>
            </>
          ) : est ? (
            <span className="est-note">
              Estimated location (not reported): {est.lat.toFixed(3)}, {est.lon.toFixed(3)} ± {(est.uncertainty_radius_m / 1000).toFixed(1)} km
              <br />
              <small>{est.method}, quality {est.quality}, {est.anchor_count} anchors, {est.sample_count} samples. {(est.reasons ?? []).join(' ')}</small>
            </span>
          ) : (
            <>
              {NR}
              {snapNode?.estimate_note && <><br /><small>No estimate: {snapNode.estimate_note}</small></>}
            </>
          )}
        </dd>
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
        <dt>Seen in window</dt><dd>{d.first_seen ? `${formatLocal(d.first_seen)} → ${formatLocal(d.last_seen)} (${relativeAge(d.last_seen, now)})` : NR}</dd>
        <dt>Traffic</dt><dd>{d.packets} unique packets · {d.receptions} receptions · uplinked {d.gateway_receptions} as gateway</dd>
        <dt>Signatures</dt>
        <dd>
          {d.signatures.verified} verified · {d.signatures.unsigned} unsigned · {d.signatures.unverifiable} unverifiable · {d.signatures.not_applicable} n/a
        </dd>
        <dt>Brokers</dt><dd>{d.brokers?.length ? d.brokers.join(', ') : NR}</dd>
        <dt>Battery</dt><dd>{d.telemetry ? <>{fmt(d.telemetry.battery, '%', 0)} · {fmt(d.telemetry.voltage, 'V', 2)} · ch util {fmt(d.telemetry.ch_util, '%')} · air {fmt(d.telemetry.air_util, '%')}</> : NR}</dd>
      </dl>
      {(d.telemetry_series ?? []).length > 1 && (
        <div className="charts">
          <Sparkline label="Battery %" points={(d.telemetry_series ?? []).map((s) => [Date.parse(s.at), s.battery ?? null])} />
          <Sparkline label="Channel utilisation %" points={(d.telemetry_series ?? []).map((s) => [Date.parse(s.at), s.ch_util ?? null])} />
        </div>
      )}
      <ReachSection key={d.id} id={d.id} name={(n) => names.get(n) ?? n} />
      <h3>Links in window ({edges.length})</h3>
      <ul className="links">
        {edges.map((e) => (
          <li key={e.src + e.dst + (e.mqtt ? 'm' : '')}>
            <button onClick={() => select({ kind: 'edge', src: e.src, dst: e.dst, mqtt: !!e.mqtt })}>
              {e.src === id ? <>→ {names.get(e.dst) ?? e.dst}</> : <>← {names.get(e.src) ?? e.src}</>}{' '}
              {e.mqtt ? <span className="conf conf-mqtt" title="Over the internet through an MQTT broker, not radio">Internet</span> : <span className={`conf conf-${e.confidence}`}>{e.confidence}</span>} {e.snr.median !== undefined && e.snr.median !== null && <small>SNR {e.snr.median} dB</small>}
            </button>
          </li>
        ))}
      </ul>
      <h3>Heard by gateways ({(d.heard_by ?? []).length})</h3>
      <table className="hear">
        <thead><tr><th>Gateway</th><th>Rx</th><th>Direct</th><th>SNR med</th><th>RSSI med</th></tr></thead>
        <tbody>
          {(d.heard_by ?? []).slice(0, 30).map((h) => (
            <tr key={h.node}><td>{names.get(h.node) ?? h.node}</td><td>{h.receptions}</td><td>{h.direct_rf}</td><td>{fmt(h.snr.median, 'dB')}</td><td>{fmt(h.rssi.median, 'dBm', 0)}</td></tr>
          ))}
        </tbody>
      </table>
      {(d.radio?.heard_as ?? []).length > 1 && (
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
      <PacketLogs id={id} names={names} positioned={positioned} />
      <p className="muted">Message contents are never stored or shown.</p>
    </div>
  )
}

/** The selected node's packets in the window: its own, and others' it relayed. */
function PacketLogs({ id, names, positioned }: { id: string; names: Map<string, string>; positioned: Set<string> }) {
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
    | { kind: 'own'; hops?: number; signature: string }
    | { kind: 'relayed'; origin: string; evidence: ('relay_byte' | 'traceroute')[] }
  )
  // Newest first; times parsed once per log, not inside the comparator on every render.
  const data = log.data
  const entries = useMemo(() => {
    const all: Entry[] = [
      ...(data?.own ?? []).map((p) => ({ ...p, kind: 'own' as const })),
      ...(withRelayed ? (data?.relayed ?? []).map((p) => ({ ...p, kind: 'relayed' as const, gateways: p.gateways.length })) : []),
    ]
    const ms = new Map(all.map((e) => [e, Date.parse(e.at)]))
    return all.sort((a, b) => ms.get(b)! - ms.get(a)!)
  }, [data, withRelayed])
  return (
    <>
      <div className="log-head">
        <h3>Packet log ({own.length + (withRelayed ? relayed.length : 0)}{log.data?.truncated ? '+' : ''})</h3>
        <label title="Other nodes' packets this node passed on: a gateway's last-hop byte resolved to it, or it is in a traceroute's recorded route">
          <input type="checkbox" checked={withRelayed} onChange={(e) => setWithRelayed(e.target.checked)} /> Include relayed ({relayed.length})
        </label>
      </div>
      {log.isLoading && <p className="muted">Loading…</p>}
      <RouteNote positioned={positioned} />
      <p className="muted small">Select a packet to draw its route on the map.</p>
      <table className="hear pkt-log" aria-label="Packet log">
        <colgroup><col style={{ width: 60 }} /><col /><col style={{ width: 92 }} /><col /><col style={{ width: 70 }} /><col style={{ width: 30 }} /></colgroup>
        <thead><tr><th>Time</th><th>From</th><th>Type</th><th>To</th><th title="Own packets: fewest hops any gateway saw. Relayed: how we know this node passed it on">Via</th><th title="Gateways that uplinked it (relayed: that heard this node's rebroadcast)">GWs</th></tr></thead>
        <tbody>
          {entries.slice(0, shown.own).map((p) => (
            <tr key={p.kind + p.lp} className={route === p.lp ? 'active' : undefined} onClick={() => showRoute(route === p.lp ? null : p.lp)} aria-selected={route === p.lp}>
              <td title={formatLocal(p.at)}>{formatLogTime(p.at)}</td>
              <td className="wrap" title={p.kind === 'relayed' ? nm(p.origin) : undefined}>
                {p.kind === 'own' ? <span className="ev-tag own">own</span> : (
                  <button className="linkish" onClick={(e) => { e.stopPropagation(); select({ kind: 'node', id: p.origin }) }}>{nm(p.origin)}</button>
                )}
              </td>
              <td title={p.kind === 'own' ? `${p.type} · ${SIG_LABEL[p.signature] ?? p.signature}` : p.type}>{p.type}</td>
              <td className="wrap" title={p.to && p.to !== 'broadcast' ? nm(p.to) : undefined}>{p.to === 'broadcast' ? 'all' : p.to ? nm(p.to) : ''}</td>
              <td>{p.kind === 'own' ? (p.hops !== undefined ? `${p.hops} hop${p.hops === 1 ? '' : 's'}` : '') : p.evidence.map((e) => <span key={e} className="ev-tag" title={how[e][1]}>{how[e][0]}</span>)}</td>
              <td>{p.gateways || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {more('own', entries.length)}
    </>
  )
}

/** What the drawn route shows, and what it cannot. */
function RouteNote({ positioned }: { positioned: Set<string> }) {
  const lp = useStore((s) => s.route)
  const showRoute = useStore((s) => s.showRoute)
  const r = usePacketRoute(lp)
  if (!lp) return null
  const segs = r.data?.segments ?? []
  const dashed = segs.filter((g) => g.dashed).length
  const hidden = segs.filter((g) => !positioned.has(g.a) || !positioned.has(g.b)).length
  return (
    <p className="route-note">
      Route on the map: {segs.length} segment{segs.length === 1 ? '' : 's'}{dashed ? `, ${dashed} dashed (nodes missing)` : ''}
      {hidden ? `; ${hidden} not drawn (node without position)` : ''}. Links are hidden meanwhile.{' '}
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
        NeighborInfo {e.evidence.neighbor} · traceroute {e.evidence.traceroute} · direct gateway RF {e.evidence.direct_rf} · inferred last hop {e.evidence.relay_hint}
      </dd>
      {e.mqtt ? (
        <><dt>Why internet</dt><dd><span className="conf conf-mqtt">Internet</span> {e.reason}</dd></>
      ) : (
        <><dt>Confidence</dt><dd><span className={`conf conf-${e.confidence}`}>{e.confidence}</span> — {e.reason}{e.inferred && ' (inferred)'}</dd></>
      )}
      <dt>Samples</dt><dd>{e.samples}</dd>
      {e.mqtt ? (
        <><dt>Signal</dt><dd>none: not received over radio</dd></>
      ) : (
        <>
          <dt>SNR at receiver</dt><dd>{e.snr.n ? `median ${e.snr.median} dB (min ${e.snr.min}, max ${e.snr.max}, last ${e.snr.last}; n=${e.snr.n})` : '—'}</dd>
          <dt>RSSI at receiver</dt><dd>{e.rssi.n ? `median ${e.rssi.median} dBm (min ${e.rssi.min}, max ${e.rssi.max}, last ${e.rssi.last}; n=${e.rssi.n})` : 'only measured by gateway receptions'}</dd>
        </>
      )}
      <dt>In window</dt><dd>{formatLocal(e.first_at)} → {formatLocal(e.last_at)}</dd>
      {e.zero_cost && (
        <>
          <dt title="Firmware lets a router relay what it hears from a favourite router without spending a hop (0-cost). Found from the hop limits gateways saw before and after this hop.">0-cost</dt>
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
        {e ? <><p className="muted">{mqtt ? `${name(dst)} took ${name(src)}'s packets from MQTT.` : `${name(dst)} heard ${name(src)}.`}</p>{stats(e)}</>
          : <p className="muted">{mqtt ? `No traceroute shows ${name(dst)} taking ${name(src)}'s packets from MQTT in this window.` : `No evidence that ${name(dst)} heard ${name(src)} in this window.`}</p>}
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
    </div>
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
        relays for free over a 0-cost link (gold chevrons). Links never observed are missing, and intermittent ones count as always there.
        {r && r.nodes.length > 0 && shown && <> Nearest relays: {[...new Set(r.nodes.filter((n) => n.need === 1).map((n) => n.via))].slice(0, 3).map(name).join(', ')}.</>}
      </p>
    </section>
  )
}

