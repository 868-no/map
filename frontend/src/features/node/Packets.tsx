import { useMemo, useRef, useState } from 'react'
import { PACKET_LOG_MAX, type Answer, type NodeView, type Reply, type SnapshotView } from '../../derive/views'
import { usePacketLog, usePacketRoute } from '../../state/data'
import { useStore } from '../../state/store'
import { formatLocal, formatLogTime } from '../../lib/time'
import { NodeAirtimeRow } from '../health'
import { SIG_LABEL, routingError } from './shared'
import { ColResize, useColumnWidths, type ColumnDefault } from '../../components/ColumnResize'

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

/** The Packets tab: packet log, delivery reports, airtime and signatures. */
export function PacketsTab({ d, id, snapshot, names }: { d: NodeView; id: string; snapshot: SnapshotView | undefined; names: Map<string, string> }) {
  const select = useStore((s) => s.select)
  const positioned = useMemo(() => new Set((snapshot?.nodes ?? []).filter((n) => n.position || n.estimate).map((n) => n.id)), [snapshot])
  const moved = useMemo(() => new Set((snapshot?.nodes ?? []).filter((n) => n.moved_at).map((n) => n.id)), [snapshot])
  return (
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
      <PacketLogs key={id} id={id} names={names} positioned={positioned} moved={moved} />
      <p className="muted">Message contents are never stored or shown.</p>
    </>
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
/** The packet log's columns: default widths (null shares what is left) and header tooltips. */
const LOG_COLS: { label: string; width: ColumnDefault; title?: string }[] = [
  { label: 'Time', width: 60 },
  { label: 'From', width: null },
  { label: 'Type', width: 92 },
  { label: 'To', width: null },
  { label: 'Hops', width: 70, title: "Own packets: the fewest hops another gateway's copy shows (hop start minus hop limit; relays over 0-cost links spend none, so it can be fewer than the relays). 'self': only it uplinked it. 'MQTT': a copy came through an MQTT downlink. Relayed: how we know this node passed it on" },
  { label: 'GWs', width: 30, title: "Other gateways that uplinked it (relayed: that heard this node's rebroadcast)" },
  { label: 'Re', width: 34, title: 'Delivery reports: ✓ an ACK or ✗ an error answered this packet. Only reports that reached a gateway are known, so a blank never means it was lost. For a routing packet, ↩ selects the packet it answers' },
]

function PacketLogs({ id, names, positioned, moved }: { id: string; names: Map<string, string>; positioned: Set<string>; moved: Set<string> }) {
  const select = useStore((s) => s.select)
  const route = useStore((s) => s.route)
  const showRoute = useStore((s) => s.showRoute)
  const [withRelayed, setWithRelayed] = useState(false)
  const log = usePacketLog(id)
  // Rows shown of the merged list; more on request.
  const [shown, setShown] = useState(50)
  // Resizable columns, remembered in the browser.
  const cols = useColumnWidths('meshmap.packetLogColumns', LOG_COLS.map((c) => c.width))
  const heads = useRef<(HTMLTableCellElement | null)[]>([])
  const more = (total: number) =>
    total > shown && <button className="more" onClick={() => setShown((s) => s + 100)}>Show more ({total - shown} hidden)</button>
  const own = log.data?.own ?? []
  const relayed = log.data?.relayed ?? []
  const nm = (n: string) => names.get(n) ?? n
  const how = {
    relay_byte: ['byte', "A gateway's last-hop byte resolved to this node"],
    traceroute: ['route', "This node is in the traceroute's recorded route"],
  } as const
  type Entry = { lp: string; at: string; type: string; to?: string; gateways: number } & (
    | { kind: 'own'; hops?: number; signature: string; by_itself?: boolean; downlinked?: boolean; replies?: Reply[]; answers?: Answer; in_response_to?: string; invalid?: string }
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
          <input type="checkbox" checked={withRelayed} onChange={(e) => setWithRelayed(e.target.checked)} /> Include relayed ({relayed.length}{log.data?.truncated && relayed.length >= PACKET_LOG_MAX ? '+' : ''})
        </label>
      </div>
      {log.isLoading && <p className="muted">Loading…</p>}
      <RouteNote positioned={positioned} moved={moved} name={(n) => names.get(n) ?? n} />
      <p className="muted small">Select a packet to draw its route on the map.</p>
      <div className="pkt-log-wrap">
      <table className="hear pkt-log" aria-label="Packet log" style={{ minWidth: cols.minWidth }}>
        <colgroup>{cols.widths.map((w, i) => <col key={LOG_COLS[i].label} style={w === null ? undefined : { width: w }} />)}</colgroup>
        <thead>
          <tr>
            {LOG_COLS.map((c, i) => (
              <th key={c.label} title={c.title} ref={(el) => { heads.current[i] = el }}>
                {c.label}
                {i < LOG_COLS.length - 1 && <ColResize label={c.label} width={cols.widths[i]} measure={() => heads.current[i]?.getBoundingClientRect().width ?? 60} onChange={(w) => cols.update(i, w)} />}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.slice(0, shown).map((p) => (
            <tr key={p.kind + p.lp} data-kind={p.kind} className={route === p.lp ? 'active' : undefined} onClick={() => showRoute(route === p.lp ? null : p.lp)} aria-selected={route === p.lp}
              tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showRoute(route === p.lp ? null : p.lp) } }} title="Select (click, Enter or Space) to draw this packet's route on the map">
              <td title={formatLocal(p.at)}>{formatLogTime(p.at)}</td>
              <td className="wrap" title={p.kind === 'relayed' ? nm(p.origin) : undefined}>
                {p.kind === 'own' ? (
                  <>
                    <span className="ev-tag own">own</span>
                    {p.in_response_to && (
                      <span title="It sent this in answer to that node's packet, not of its own accord">
                        , in response to{' '}
                        <button className="linkish" onClick={(e) => { e.stopPropagation(); select({ kind: 'node', id: p.in_response_to! }) }}>{nm(p.in_response_to)}</button>
                      </span>
                    )}
                  </>
                ) : (
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
      </div>
      {more(entries.length)}
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
      {segs.some((g) => g.leg) && <> Traceroute both ways: <span className="leg-forward">pink</span> the way there (request), <span className="leg-back">blue</span> the way back (reply), each beside the line between two nodes.</>}
      {r.data?.delivered?.length ? ` Delivery confirmed by ${r.data.delivered.map(name).join(', ')} (ACK; dashed green where the path is not known).` : ''}
      {movers.length > 0 && ` ${movers.map(name).join(', ')} moved during the window: drawn where ${movers.length === 1 ? 'it was' : 'they were'} when this packet was heard (ring), dashed to where ${movers.length === 1 ? 'it is' : 'they are'} now.`} Links are hidden meanwhile.{' '}
      <button className="linkish" onClick={() => showRoute(null)}>Clear route</button>
    </p>
  )
}
