// A node's history over everything the server keeps (D-195): the window
// shows at most 14 days, so "has it got worse since it was moved?" is asked
// of the server's hourly summaries. Loaded only when the section is opened.
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError, getJSON } from '../../api/client'
import { BarChart } from '../../components/BarChart'
import { PERIOD_NAME, VIEWER_TZ, periodLabels, type Period } from '../../lib/periods'
import { historyRows, type NodeTrends } from './historyRows'

/** The collapsed History section at the foot of the Overview tab. */
export function NodeHistory({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="node-history" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>History, everything kept</summary>
      {open && <HistoryBody id={id} />}
    </details>
  )
}

const status = (e: unknown) => (e instanceof ApiError ? e.status : 0)

function HistoryBody({ id }: { id: string }) {
  const [period, setPeriod] = useState<Period>('week')
  const q = useQuery({
    queryKey: ['node-trends', id, period, VIEWER_TZ],
    queryFn: ({ signal }) => getJSON<NodeTrends>(`/api/v1/trends/node/${encodeURIComponent(id)}`, new URLSearchParams({ bucket: period, tz: VIEWER_TZ }), signal),
    staleTime: 15 * 60_000, // as long as the response may be cached (max-age)
    // 503: the server is still reading the log after a start; ask again for a while.
    retry: (n, e) => status(e) === 503 && n < 6,
    retryDelay: 10_000,
  })
  const { rows, labels } = useMemo(() => {
    const rows = historyRows(q.data?.buckets ?? [])
    return { rows, labels: periodLabels(rows.map((r) => r.start), period) }
  }, [q.data, period])
  const charts = useMemo(() => ({
    heard: rows.map((r, i) => ({ label: labels[i], value: r.heardPct, text: r.heardPct === null ? 'nothing logged' : `${r.heardPct} % (${r.heard} of ${r.hours} h)` })),
    packets: rows.map((r, i) => ({ label: labels[i], value: r.packets })),
    perPacket: rows.map((r, i) => ({ label: labels[i], value: r.perPacket, text: r.perPacket === null ? 'no packets' : undefined })),
    gateway: rows.some((r) => r.gateway > 0) ? rows.map((r, i) => ({ label: labels[i], value: r.gatewayPct, text: r.gatewayPct === null ? 'nothing logged' : `${r.gatewayPct} % (${r.gateway} h)` })) : [],
    battery: (q.data?.buckets ?? []).some((b) => b.battery_min !== undefined) ? rows.map((r, i) => ({ label: labels[i], value: r.battery, text: r.battery === null ? r.batteryText : undefined })) : [],
  }), [rows, labels, q.data])
  const waiting = status(q.failureReason) === 503
  return (
    <div className="node-history-body">
      <div className="segmented" role="group" aria-label="History period">
        {(['day', 'week', 'month'] as const).map((p) => (
          <button key={p} aria-pressed={period === p} onClick={() => setPeriod(p)}>{PERIOD_NAME[p]}</button>
        ))}
      </div>
      <p className="muted small">
        From the server&apos;s hourly summaries of everything it keeps{q.data?.since ? `, since ${new Date(q.data.since).toLocaleDateString()}` : ''}, in your time zone ({VIEWER_TZ}),
        from the {period} this node was first heard in. Not affected by the selected period or filters. The first {period} may be partial, and so is the current one.
      </p>
      {q.isPending && <p className="muted">{waiting ? 'The server is still counting its history after a restart; trying again…' : 'Counting…'}</p>}
      {q.isError && (
        <p className="muted">
          {status(q.error) === 404 ? 'Nothing from this node is in the long-term summaries yet: they are brought up to date every few minutes.'
            : status(q.error) === 503 ? 'The server is still counting its history; try again in a minute.'
            : 'History is unavailable right now.'}
        </p>
      )}
      {rows.length > 0 && (
        <>
          <div className="tcharts">
            <BarChart title="Heard" unit="%" max={100} bars={charts.heard}
              note="Of the hours in which the server logged anything at all, the share in which this node sent something: its uptime as the mesh saw it. Hours the server heard nothing are not held against it." />
            <BarChart title="Packets" bars={charts.packets} note="Its own distinct packets, each once however many gateways heard it" />
            <BarChart title="Gateways per packet" bars={charts.perPacket}
              note="Receptions of its packets divided by its packets: how many gateways heard each one, on average. Fewer after a move means fewer gateways hear it." />
            <BarChart title="As gateway" unit="%" max={100} bars={charts.gateway} note="Of the hours in which anything was logged, the share in which it uplinked anything to MQTT" />
            <BarChart title="Lowest battery" unit="%" max={100} bars={charts.battery} note="The lowest battery level its device telemetry reported; no bar where it reported none, or only external power" />
          </div>
          <table className="hear trends-table" aria-label="History by period">
            <thead>
              <tr>
                <th>{{ day: 'Day', week: 'Week', month: 'Month' }[period]}</th>
                <th title="Hours it sent anything in, of the hours anything was logged">Heard</th>
                <th title="Its distinct packets">Pkts</th>
                <th title="Gateways per packet (receptions ÷ packets)">GW/pkt</th>
                <th title="Hours it uplinked as a gateway">GW h</th>
                <th title="Lowest battery level reported">Batt</th>
              </tr>
            </thead>
            <tbody>
              {/* Newest first. */}
              {rows.map((r, i) => (
                <tr key={r.start}>
                  <td>{labels[i]}</td>
                  <td>{r.heard}/{r.hours} h</td>
                  <td>{r.packets.toLocaleString()}</td>
                  <td>{r.perPacket ?? '—'}</td>
                  <td>{r.gateway}</td>
                  <td>{r.batteryText === 'no report' ? '—' : r.batteryText}</td>
                </tr>
              )).reverse()}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
