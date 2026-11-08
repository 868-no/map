// Long-term trends (D-104): daily, weekly and monthly summaries over the whole
// retained log, computed by the server (views stop at a week of rows).
import { memo, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getJSON } from '../api/client'
import type { components } from '../api/schema'
import { BarChart } from '../components/BarChart'
import { PERIOD_NAME, VIEWER_TZ as TZ, periodLabels, type Period as Bucket } from '../lib/periods'
import { TYPE_LABEL } from './controls'

type Trends = components['schemas']['TrendsBody']

function useTrends(bucket: Bucket) {
  return useQuery({
    queryKey: ['trends', bucket, TZ],
    queryFn: ({ signal }) => getJSON<Trends>('/api/v1/trends', new URLSearchParams({ bucket, tz: TZ }), signal),
    staleTime: 15 * 60_000, // as long as the response may be cached (max-age)
  })
}

/**
 * Memoised (no props): it sits in the dock, which re-renders with every live
 * rebuild, while its data changes at most every 15 minutes.
 */
export const TrendsPanel = memo(function TrendsPanel() {
  const [bucket, setBucket] = useState<Bucket>('day')
  const t = useTrends(bucket)
  // Labels and totals once per answer, not per render.
  const { buckets, labels, shares, allPackets } = useMemo(() => {
    const buckets = t.data?.buckets ?? []
    const labels = periodLabels(buckets.map((b) => b.start), bucket)
    const totals = new Map<string, number>()
    for (const b of buckets) for (const [k, v] of Object.entries(b.by_type ?? {})) totals.set(k, (totals.get(k) ?? 0) + v)
    const max = Math.max(1, ...totals.values())
    const shares = [...totals].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v, w: (v / max) * 100 }))
    return { buckets, labels, shares, allPackets: [...totals.values()].reduce((a, b) => a + b, 0) }
  }, [t.data, bucket])
  const charts = useMemo(() => ({
    nodes: buckets.map((b, i) => ({ label: labels[i], value: b.nodes, part: b.new_nodes })),
    gateways: buckets.map((b, i) => ({ label: labels[i], value: b.gateways })),
    packets: buckets.map((b, i) => ({ label: labels[i], value: b.packets })),
    receptions: buckets.map((b, i) => ({ label: labels[i], value: b.receptions })),
  }), [buckets, labels])
  return (
    <div className="panel trends-panel">
      <div className="segmented" role="group" aria-label="Summary period">
        {(['day', 'week', 'month'] as const).map((b) => (
          <button key={b} aria-pressed={bucket === b} onClick={() => setBucket(b)}>{PERIOD_NAME[b]}</button>
        ))}
      </div>
      <p className="muted small">
        Over everything the server keeps{t.data?.since ? `, since ${new Date(t.data.since).toLocaleDateString()}` : ''}, in your time zone ({TZ}).
        The first {bucket} may be partial, and so is the current one. Not affected by the window or filters.
      </p>
      {t.isLoading && <p className="muted">Counting…</p>}
      {t.error && <p className="muted">Trends are unavailable right now.</p>}
      {buckets.length > 0 && (
        <>
          <div className="tcharts">
            <BarChart title="Nodes heard" partLabel="new" note="Distinct nodes that sent anything; new: first heard in that period" bars={charts.nodes} />
            <BarChart title="Gateways" note="Distinct gateways that uplinked anything" bars={charts.gateways} />
            <BarChart title="Packets" note="Distinct packets, each once however many gateways heard it" bars={charts.packets} />
            <BarChart title="Receptions" note="Gateway receptions of those packets" bars={charts.receptions} />
          </div>
          <h3>Packets by type, whole period</h3>
          <ul className="shares">
            {shares.map(({ k, v, w }) => (
              <li key={k} className="share">
                <span className="share-label">{TYPE_LABEL[k] ?? k}</span>
                <span className="share-bar"><span style={{ width: `${w}%` }} /></span>
                <span className="share-pct">{allPackets ? `${Math.round((v / allPackets) * 100)} %` : ''}</span>
              </li>
            ))}
          </ul>
          <h3>Every {bucket}</h3>
          <table className="hear trends-table">
            <thead><tr><th>{{ day: 'Day', week: 'Week', month: 'Month' }[bucket]}</th><th title="Nodes heard">Nodes</th><th title="Nodes first heard">New</th><th title="Gateways">GWs</th><th title="Distinct packets">Packets</th><th title="Receptions">Rx</th></tr></thead>
            <tbody>
              {/* Newest first. */}
              {buckets.map((b, i) => (
                <tr key={b.start}><td>{labels[i]}</td><td>{b.nodes}</td><td>{b.new_nodes}</td><td>{b.gateways}</td><td>{b.packets.toLocaleString()}</td><td>{b.receptions.toLocaleString()}</td></tr>
              )).reverse()}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
})
