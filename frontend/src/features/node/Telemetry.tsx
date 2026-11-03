import type { NodeView, SnapshotView } from '../../derive/views'
import { formatLocal } from '../../lib/time'
import { ChartGroup, TimeChart, type Band, type Series } from '../../components/TimeChart'
import { useWeather, weatherPoints, weatherSite } from '../../state/weather'
import { nights as nightsAt } from '../../lib/sun'
import { NR, fmt } from './shared'

/** Firmware reports battery level 101 when on external power. */
const battery = (v: number | undefined) => (v === undefined || v === null ? '—' : v > 100 ? 'external power' : `${Math.round(v)} %`)

/** The Telemetry tab: battery, power, channel use and sensor readings over the window. */
export function TelemetryTab({ d, snapshot, now }: { d: NodeView; snapshot: SnapshotView | undefined; now: number }) {
  const env = d.environment_series ?? []
  const dev = d.telemetry_series ?? []
  const telemetryCount = dev.length + env.length
  const winStart = snapshot ? Date.parse(snapshot.meta.window.start) : Math.min(...[...dev, ...env].map((s) => Date.parse(s.at)))
  const winEnd = now
  // Routers get the weather at their site behind their own readings (D-133).
  const [weather] = useWeather([weatherSite(d)], winStart, winEnd)
  const w = weather?.data
  const loading = w?.incomplete ? 'Loading… ' : ''
  const band = (b: Omit<Band, 'points' | 'note'>, k: Parameters<typeof weatherPoints>[1], what?: string): Band | undefined =>
    w ? { ...b, points: weatherPoints(w.hours, k), note: what && `${loading}${what} at its site, MET Norway (CC BY 4.0)` } : undefined
  const tempBand = band({ label: 'Weather', unit: '°C', color: 'var(--orange)', kind: 'level' }, 'temp_c', 'Air temperature')
  const humidityBand = band({ label: 'Weather', unit: '%', color: 'var(--orange)', kind: 'level', decimals: 0 }, 'humidity_pct', 'Relative humidity')
  // Behind voltage, for solar nodes: cloud cover, and the sunlight that got
  // through, as the hour's mean drawn mid-hour; night from the sun's height.
  const cloudBand = band({ label: 'Cloud cover', unit: '%', color: 'var(--muted)', kind: 'share', domain: [0, 100], decimals: 0 }, 'cloud_pct')
  const sunBand = band({ label: 'Sunlight', unit: 'W/m²', color: 'var(--warn)', kind: 'share', decimals: 0 }, 'sun_wm2', 'Cloud cover and sunlight reaching the ground')
  if (sunBand) sunBand.points = sunBand.points.map(([t, v]) => [t - 1_800_000, v])
  const here = d.refined ?? d.position
  const nights = here && Number.isFinite(winStart) ? nightsAt(here.lat, here.lon, winStart, winEnd) : undefined
  const wind: Series[] = w ? [
    { label: 'Wind', color: 'var(--accent)', points: weatherPoints(w.hours, 'wind_ms') },
    { label: 'Gusts', color: 'var(--orange)', points: weatherPoints(w.hours, 'gust_ms') },
  ] : []
  const hasWeather = !!w && w.hours != null && w.hours.length > 0
  // Until the first hours arrive there is nothing to chart: say so.
  const weatherLoading = !hasWeather && !!weatherSite(d) && (weather?.isLoading || !!w?.incomplete) && (
    <p className="muted small">Loading weather from MET Norway…</p>
  )
  const windChart = hasWeather && (
    <div>
      <TimeChart label="Wind" unit="m/s" start={winStart} end={winEnd} series={wind} />
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
              <TimeChart label="Voltage" unit="V" decimals={2} start={winStart} end={winEnd} bands={[cloudBand, sunBand]} nights={nights} />
              <TimeChart label="Temperature" unit="°C" start={winStart} end={winEnd} bands={[tempBand]} />
              <TimeChart label="Humidity" unit="%" decimals={0} domain={[0, 100]} start={winStart} end={winEnd} bands={[humidityBand]} />
              {windChart}
            </ChartGroup>
          )}
        </>
      ) : (
        <ChartGroup>
          <TimeChart label="Battery" unit="%" decimals={0} domain={[0, 100]} start={winStart} end={winEnd}
            points={dev.map((s) => [Date.parse(s.at), s.battery != null && s.battery <= 100 ? s.battery : null])}
            empty={dev.some((s) => s.battery != null && s.battery > 100) ? 'on external power' : undefined} />
          <TimeChart label="Voltage" unit="V" decimals={2} start={winStart} end={winEnd} points={dev.map((s) => [Date.parse(s.at), s.voltage ?? null])} bands={[cloudBand, sunBand]} nights={nights} />
          <TimeChart label="Channel utilisation" unit="%" start={winStart} end={winEnd} points={dev.map((s) => [Date.parse(s.at), s.ch_util ?? null])} />
          <TimeChart label="Own airtime" unit="%" decimals={2} start={winStart} end={winEnd} points={dev.map((s) => [Date.parse(s.at), s.air_util ?? null])} />
          <TimeChart label="Uptime" unit="days" decimals={1} start={winStart} end={winEnd} points={dev.map((s) => [Date.parse(s.at), s.uptime != null ? s.uptime / 86_400 : null])} />
          <TimeChart label="Temperature" unit="°C" start={winStart} end={winEnd} points={env.map((s) => [Date.parse(s.at), s.temp ?? null])} bands={[tempBand]} />
          <TimeChart label="Humidity" unit="%" decimals={0} domain={[0, 100]} start={winStart} end={winEnd} points={env.map((s) => [Date.parse(s.at), s.humidity ?? null])} bands={[humidityBand]} />
          <TimeChart label="Pressure" unit="hPa" decimals={0} start={winStart} end={winEnd} points={env.map((s) => [Date.parse(s.at), s.pressure ?? null])} />
          {windChart}
        </ChartGroup>
      )}
      {telemetryCount > 0 && weatherLoading}
      {d.truncated && <p className="muted small">Long series show only their latest 500 reports.</p>}
    </>
  )
}
