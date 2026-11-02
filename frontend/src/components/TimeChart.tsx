// A telemetry time series over the selected period (D-100): the x axis is the
// whole window, so charts of one node line up and gaps show when it was
// silent. Hovering (or touching) reads off the nearest report.
import { useRef, useState, type PointerEvent } from 'react'
import { formatLocal } from '../lib/time'

const W = 300, H = 80 // viewBox units; the plot stretches to the panel width

export interface TimeChartProps {
  label: string
  unit: string
  points: [number, number | null][] // [ms, value]; null: no reading in that report
  start: number // window, ms
  end: number
  decimals?: number
  /** A fixed value range (percentages), else the data's own with some margin. */
  domain?: [number, number]
  /** Shown instead of the chart when no point has a value. */
  empty?: string
}

const short = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** Breaks the line where reports stop for much longer than usual. */
function segments(pts: [number, number][]): [number, number][][] {
  if (pts.length < 2) return [pts]
  const gaps = pts.slice(1).map((p, k) => p[0] - pts[k][0]).sort((a, b) => a - b)
  const typical = gaps[Math.floor(gaps.length / 2)]
  const limit = Math.max(2 * 3_600_000, 4 * typical)
  const out: [number, number][][] = [[pts[0]]]
  for (let k = 1; k < pts.length; k++) {
    if (pts[k][0] - pts[k - 1][0] > limit) out.push([])
    out[out.length - 1].push(pts[k])
  }
  return out
}

export function TimeChart({ label, unit, points, start, end, decimals = 1, domain, empty }: TimeChartProps) {
  const pts = points.filter((p): p is [number, number] => p[1] !== null && Number.isFinite(p[1])).sort((a, b) => a[0] - b[0])
  const box = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<[number, number] | null>(null)
  if (pts.length === 0) return empty ? <p className="muted small">{label}: {empty}</p> : null
  const ys = pts.map((p) => p[1])
  let [y0, y1] = domain ?? [Math.min(...ys), Math.max(...ys)]
  if (!domain) {
    const pad = Math.max((y1 - y0) * 0.1, 10 ** -decimals)
    // Quantities that cannot be negative (percentages, durations) never get a negative axis.
    y0 = unit === '%' || unit === 'days' ? Math.max(0, y0 - pad) : y0 - pad
    y1 += pad
  }
  const span = Math.max(end - start, 1)
  const sx = (t: number) => ((t - start) / span) * W
  const sy = (v: number) => H - ((Math.min(Math.max(v, y0), y1) - y0) / Math.max(y1 - y0, 1e-9)) * H
  const fmt = (v: number) => `${v.toFixed(decimals)}${unit === '%' ? ' %' : unit ? ` ${unit}` : ''}`
  const lines = segments(pts).map((seg) => seg.map((p, k) => `${k ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' '))
  const last = pts[pts.length - 1]
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = box.current!.getBoundingClientRect()
    const t = start + ((e.clientX - r.left) / r.width) * span
    let best = pts[0]
    for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p
    setHover(best)
  }
  const shown = hover ?? last
  return (
    <figure className="tchart">
      <figcaption>
        <span className="tchart-label">{label}</span>
        <span className="tchart-read" aria-live="polite">
          {fmt(shown[1])} <small className="muted">{hover ? formatLocal(new Date(shown[0]).toISOString()) : 'latest'}</small>
        </span>
      </figcaption>
      <div className="tchart-plot" ref={box} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        <span className="tchart-y top">{fmt(y1)}</span>
        <span className="tchart-y bottom">{fmt(y0)}</span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
          aria-label={`${label}: ${pts.length} reports, from ${fmt(Math.min(...ys))} to ${fmt(Math.max(...ys))}, latest ${fmt(last[1])}`}>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} className="tchart-grid" x1={0} x2={W} y1={H * f} y2={H * f} />)}
          {lines.map((d, k) => <path key={k} d={d} className="tchart-line" vectorEffect="non-scaling-stroke" />)}
          {pts.length <= 40 && pts.map((p) => <circle key={p[0]} cx={sx(p[0])} cy={sy(p[1])} r={1.6} className="tchart-dot" vectorEffect="non-scaling-stroke" />)}
          {hover && <line className="tchart-cursor" x1={sx(hover[0])} x2={sx(hover[0])} y1={0} y2={H} vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      <div className="tchart-x muted">
        <span>{short.format(start)}</span>
        <span>{short.format(start + span / 2)}</span>
        <span>{short.format(end)}</span>
      </div>
    </figure>
  )
}
