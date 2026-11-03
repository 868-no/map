import { useEffect, useMemo, useState } from 'react'
import type { Edge, MeshNode, NodeView, SnapshotView } from '../../derive/views'
import { useReach } from '../../state/data'
import { useStore } from '../../state/store'
import { PALETTES } from '../../map/palette'
import { useTheme } from '../../theme'
import { fmt } from './shared'
import { sortHearings, type LinkNeighbour } from './sort'

/** The Links tab: radio links, gateways that heard it, reach and relaying. */
export function LinksTab({ d, id, snapshot, snapNode, names, neighbours }: {
  d: NodeView
  id: string
  snapshot: SnapshotView | undefined
  snapNode: MeshNode | undefined
  names: Map<string, string>
  neighbours: LinkNeighbour[]
}) {
  const select = useStore((s) => s.select)
  const heardBy = useMemo(() => sortHearings(d.heard_by ?? [], id, snapshot?.edges ?? [], names), [d, id, snapshot, names])
  return (
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
