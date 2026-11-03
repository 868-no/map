import type { NodeView, SnapshotView } from '../../derive/views'
import { formatLocal } from '../../lib/time'
import { TimeChart } from '../../components/TimeChart'
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
  )
}
