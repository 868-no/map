import type { Edge, SnapshotView } from '../derive/views'
import { useLinkHistory } from '../state/data'
import { useStore } from '../state/store'
import { formatLocal } from '../lib/time'
import { TimeChart } from '../components/TimeChart'
import { nodeName } from '../map/model'

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
