import { useMemo } from 'react'
import type { Edge, SnapshotView } from '../derive/views'
import { useLinkHistory } from '../state/data'
import { useStore } from '../state/store'
import { formatLocal } from '../lib/time'
import { ChartGroup, TimeChart, type Band } from '../components/TimeChart'
import { meanPoints, useWeather, weatherPoints, weatherSite } from '../state/weather'
import { namesOf } from '../map/model'
import { terrainEnd, useTerrainEnabled, useTerrainProfile } from '../state/terrain'
import { CrossSection, LOS_LABEL, LOS_TITLE } from '../components/CrossSection'

export function EdgePanel({ a, b, mqtt = false, snapshot }: { a: string; b: string; mqtt?: boolean; snapshot: SnapshotView | undefined }) {
  const select = useStore((s) => s.select)
  const names = namesOf(snapshot?.nodes)
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
      {!mqtt && snapshot && <LineOfSight a={a} b={b} name={name} snapshot={snapshot} />}
      {direction(a, b)}
      {direction(b, a)}
      {!mqtt && snapshot && <LinkHistoryCharts a={a} b={b} name={name} snapshot={snapshot} start={Date.parse(snapshot.meta.window.start)} end={Date.parse(snapshot.meta.window.end)} />}
    </div>
  )
}

/** The link's terrain cross section, between reported positions (D-143). */
function LineOfSight({ a, b, name, snapshot }: { a: string; b: string; name: (id: string) => string; snapshot: SnapshotView }) {
  const node = (id: string) => snapshot.nodes.find((n) => n.id === id)
  const ea = terrainEnd(node(a)), eb = terrainEnd(node(b))
  const enabled = useTerrainEnabled()
  const { q: p, gaveUp } = useTerrainProfile(ea, eb)
  if (!enabled || !ea || !eb) return null
  return (
    <section className="line-of-sight">
      <h3 title="From Kartverket's terrain model, between the positions the two nodes report">
        Line of sight {p.data && !p.data.incomplete && <span className={`conf los-${p.data.class}`} title={LOS_TITLE[p.data.class]}>{LOS_LABEL[p.data.class]}</span>}
      </h3>
      {p.isError && <p className="muted small">Terrain unavailable: {p.error.message}</p>}
      {gaveUp ? <p className="muted small">Terrain heights are still missing from Kartverket; try again later.</p>
        : (p.isLoading || p.data?.incomplete) && <p className="muted small">Loading terrain heights from Kartverket…</p>}
      {p.data && !p.data.incomplete && <CrossSection profile={p.data} nameA={name(a)} nameB={name(b)} />}
    </section>
  )
}

const EV_LABEL: Record<string, string> = { neighbor: 'NeighborInfo', traceroute: 'traceroute', direct_rf: 'heard directly', relay_hint: 'relay guess' }

/** The link's signal over the selected period, both directions (D-105). */
function LinkHistoryCharts({ a, b, name, snapshot, start, end }: { a: string; b: string; name: (id: string) => string; snapshot: SnapshotView; start: number; end: number }) {
  const h = useLinkHistory(a, b)
  // Precipitation behind the SNR (D-133): the mean of the ends that are
  // stationary routers, as rain or snow anywhere along the path may matter.
  const ends = [a, b].map((id) => snapshot.nodes.find((n) => n.id === id)).filter((n) => weatherSite(n))
  const weather = useWeather(ends.map(weatherSite), start, end)
  // Chart inputs keep their identity between renders unless their data
  // changes: TimeChart prepares again whenever they do. (At most two ends.)
  const [w0, w1] = [weather[0]?.data, weather[1]?.data]
  const rainNote = `${weather.some((w) => w.data?.incomplete) ? 'Loading… ' : ''}per hour, ${ends.length > 1 ? `mean of ${ends.map((n) => name(n!.id)).join(' and ')}` : ends.length ? `at ${name(ends[0]!.id)}` : ''}, MET Norway (CC BY 4.0)`
  const rain = useMemo((): (Band | undefined)[] => {
    const loaded = [w0, w1].filter((w) => w != null)
    return [loaded.length
      ? { label: 'Precipitation', unit: 'mm', color: 'var(--purple)', kind: 'amount', decimals: 1, points: meanPoints(loaded.map((w) => weatherPoints(w.hours, 'precip_mm'))), note: rainNote }
      : undefined]
  }, [w0, w1, rainNote])
  const rainLoading = ends.length > 0 && !rain[0]?.points.length && weather.some((w) => w.isLoading || w.data?.incomplete)
  const [nameA, nameB] = [name(a), name(b)]
  const series = useMemo(() => {
    const { ab = [], ba = [] } = h.data ?? {}
    const of = (k: 'snr' | 'rssi') => [
      { label: `${nameA} → ${nameB}`, color: 'var(--accent)', points: ab.map((p) => [p.t, p[k] ?? null] as [number, number | null]) },
      { label: `${nameB} → ${nameA}`, color: 'var(--warn)', points: ba.map((p) => [p.t, p[k] ?? null] as [number, number | null]) },
    ]
    return { snr: of('snr'), rssi: of('rssi') }
  }, [h.data, nameA, nameB])
  if (!h.data) return null
  const { ab, ba } = h.data
  if (ab.length + ba.length === 0) return null
  const kinds = [...new Set([...ab, ...ba].map((p) => EV_LABEL[p.ev] ?? p.ev))]
  return (
    <section className="link-history">
      <h3 title="Every measured reading of this link in the selected period, each RF event once">Signal over time</h3>
      {rainLoading && <p className="muted small">Loading precipitation from MET Norway…</p>}
      <p className="muted small">Each reading as the receiving node measured it ({kinds.join(', ')}). A falling line across days can mean a degrading antenna, cable or site; short dips are often weather or traffic.</p>
      <ChartGroup>
        <TimeChart label="SNR" unit="dB" start={start} end={end} series={series.snr} bands={rain} />
        <TimeChart label="RSSI" unit="dBm" decimals={0} start={start} end={end} series={series.rssi} empty="only measured by gateway receptions" />
      </ChartGroup>
    </section>
  )
}
