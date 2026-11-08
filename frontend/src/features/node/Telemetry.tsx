import { useMemo } from 'react'
import type { NodeView, SnapshotView } from '../../derive/views'
import { formatLocal } from '../../lib/time'
import { ChartGroup, TimeChart, type Band, type Series } from '../../components/TimeChart'
import { useWeather, weatherPoints, weatherSite } from '../../state/weather'
import { nights as nightsAt } from '../../lib/sun'
import { NR, fmt } from './shared'

type Point = [number, number | null]
const PERCENT: [number, number] = [0, 100]
const NO_SERIES: never[] = [] // one empty series, so memos keep

/** Firmware reports battery level 101 when on external power. */
const battery = (v: number | undefined) => (v === undefined || v === null ? '—' : v > 100 ? 'external power' : `${Math.round(v)} %`)

/** The Telemetry tab: battery, power, channel use and sensor readings over the window. */
export function TelemetryTab({ d, snapshot, now }: { d: NodeView; snapshot: SnapshotView | undefined; now: number }) {
  const env = d.environment_series ?? NO_SERIES
  const dev = d.telemetry_series ?? NO_SERIES
  const floor = d.noise_floor_series ?? NO_SERIES
  const telemetryCount = dev.length + env.length + floor.length
  const winStart = snapshot ? Date.parse(snapshot.meta.window.start) : Math.min(...[...dev, ...env].map((s) => Date.parse(s.at)), ...floor.map((p) => p[0]))
  const winEnd = now
  // Routers get the weather at their site behind their own readings (D-133).
  const [weather] = useWeather([weatherSite(d)], winStart, winEnd)
  const w = weather?.data
  const loading = w?.incomplete ? 'Loading… ' : ''
  // Everything the charts draw, built once per node view and weather answer:
  // TimeChart prepares (sorts, builds paths) whenever these change identity,
  // and this panel re-renders with every App update.
  const c = useMemo(() => {
    const band = (b: Omit<Band, 'points' | 'note'>, k: Parameters<typeof weatherPoints>[1], what?: string): Band | undefined =>
      w ? { ...b, points: weatherPoints(w.hours, k), note: what && `${loading}${what} at its site, MET Norway (CC BY 4.0)` } : undefined
    // Behind voltage, for solar nodes: cloud cover, and the sunlight that got
    // through, as the hour's mean drawn mid-hour; night from the sun's height.
    const sunBand = band({ label: 'Sunlight', unit: 'W/m²', color: 'var(--warn)', kind: 'share', decimals: 0 }, 'sun_wm2', 'Cloud cover and sunlight reaching the ground')
    if (sunBand) sunBand.points = sunBand.points.map(([t, v]) => [t - 1_800_000, v])
    const here = d.refined ?? d.position
    const wind: Series[] = w ? [
      { label: 'Wind', color: 'var(--accent)', points: weatherPoints(w.hours, 'wind_ms') },
      { label: 'Gusts', color: 'var(--orange)', points: weatherPoints(w.hours, 'gust_ms') },
    ] : []
    const at = (s: { at: string }) => Date.parse(s.at)
    return {
      temp: [band({ label: 'Weather', unit: '°C', color: 'var(--orange)', kind: 'level' }, 'temp_c', 'Air temperature')],
      humidity: [band({ label: 'Weather', unit: '%', color: 'var(--orange)', kind: 'level', decimals: 0 }, 'humidity_pct', 'Relative humidity')],
      sky: [band({ label: 'Cloud cover', unit: '%', color: 'var(--muted)', kind: 'share', domain: [0, 100], decimals: 0 }, 'cloud_pct'), sunBand],
      nights: here && Number.isFinite(winStart) ? nightsAt(here.lat, here.lon, winStart, winEnd) : undefined,
      wind,
      battery: dev.map((s): Point => [at(s), s.battery != null && s.battery <= 100 ? s.battery : null]),
      voltage: dev.map((s): Point => [at(s), s.voltage ?? null]),
      chUtil: dev.map((s): Point => [at(s), s.ch_util ?? null]),
      airUtil: dev.map((s): Point => [at(s), s.air_util ?? null]),
      uptime: dev.map((s): Point => [at(s), s.uptime != null ? s.uptime / 86_400 : null]),
      envTemp: env.map((s): Point => [at(s), s.temp ?? null]),
      envHumidity: env.map((s): Point => [at(s), s.humidity ?? null]),
      pressure: env.map((s): Point => [at(s), s.pressure ?? null]),
      floor: floor.map(([t, v]): Point => [t, v]),
    }
  }, [d, w, loading, winStart, winEnd, dev, env, floor])
  const hasWeather = !!w && w.hours != null && w.hours.length > 0
  // Until the first hours arrive there is nothing to chart: say so.
  const weatherLoading = !hasWeather && !!weatherSite(d) && (weather?.isLoading || !!w?.incomplete) && (
    <p className="muted small">Loading weather from MET Norway…</p>
  )
  const windChart = hasWeather && (
    <div>
      <TimeChart label="Wind" unit="m/s" start={winStart} end={winEnd} series={c.wind} />
      <p className="muted small">{loading}At its site, 10 m above ground: wind from the MET Nordic analysis, the hour's strongest gust from MEPS forecasts. MET Norway (CC BY 4.0)</p>
    </div>
  )
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
  return (
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
        <>
          <p className="muted">No telemetry from this node in the selected period.</p>
          {weatherLoading}
          {hasWeather && (
            <ChartGroup>
              <TimeChart label="Voltage" unit="V" decimals={2} start={winStart} end={winEnd} bands={c.sky} nights={c.nights} />
              <TimeChart label="Temperature" unit="°C" start={winStart} end={winEnd} bands={c.temp} />
              <TimeChart label="Humidity" unit="%" decimals={0} domain={PERCENT} start={winStart} end={winEnd} bands={c.humidity} />
              {windChart}
            </ChartGroup>
          )}
        </>
      ) : (
        <ChartGroup>
          <TimeChart label="Battery" unit="%" decimals={0} domain={PERCENT} start={winStart} end={winEnd}
            points={c.battery}
            empty={dev.some((s) => s.battery != null && s.battery > 100) ? 'on external power' : undefined} />
          <TimeChart label="Voltage" unit="V" decimals={2} start={winStart} end={winEnd} points={c.voltage} bands={c.sky} nights={c.nights} />
          <TimeChart label="Channel utilisation" unit="%" start={winStart} end={winEnd} points={c.chUtil} />
          <TimeChart label="Own airtime" unit="%" decimals={2} start={winStart} end={winEnd} points={c.airUtil} />
          {floor.length > 0 && (
            <div className="noise-floor">
              <TimeChart label="Noise floor" unit="dBm" decimals={0} start={winStart} end={winEnd} points={c.floor} />
              <p className="muted small">The background radio noise it measures (local statistics). A rise means more interference near it; a weaker antenna lowers the signals it hears, not its floor.</p>
            </div>
          )}
          <TimeChart label="Uptime" unit="days" decimals={1} start={winStart} end={winEnd} points={c.uptime} />
          <TimeChart label="Temperature" unit="°C" start={winStart} end={winEnd} points={c.envTemp} bands={c.temp} />
          <TimeChart label="Humidity" unit="%" decimals={0} domain={PERCENT} start={winStart} end={winEnd} points={c.envHumidity} bands={c.humidity} />
          <TimeChart label="Pressure" unit="hPa" decimals={0} start={winStart} end={winEnd} points={c.pressure} />
          {windChart}
        </ChartGroup>
      )}
      {telemetryCount > 0 && weatherLoading}
      {d.truncated && <p className="muted small">Long series show only their latest 500 reports.</p>}
    </>
  )
}
