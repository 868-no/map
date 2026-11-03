// A telemetry time series over the selected period (D-100): the x axis is the
// whole window, so charts of one node line up and gaps show when it was
// silent. Hovering (or touching) reads off the nearest report.
import { useRef, useState, type PointerEvent } from 'react'
import { formatLocal } from '../lib/time'

const W = 300, H = 80 // viewBox units; the plot stretches to the panel width

/** One line of a chart with several (D-105). */
export interface Series {
  label: string
  color: string // CSS colour
  points: [number, number | null][]
}

export interface TimeChartProps {
  label: string
  unit: string
  points?: [number, number | null][] // [ms, value]; null: no reading in that report
  series?: Series[] // several lines instead of `points`, with a legend
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

const clean = (p: [number, number | null][]) => p.filter((x): x is [number, number] => x[1] !== null && Number.isFinite(x[1])).sort((a, b) => a[0] - b[0])

export function TimeChart({ label, unit, points, series, start, end, decimals = 1, domain, empty }: TimeChartProps) {
  const lines0 = (series ?? [{ label: '', color: 'var(--accent)', points: points ?? [] }]).map((l) => ({ ...l, pts: clean(l.points) }))
  const all = lines0.flatMap((l) => l.pts.map((p) => ({ p, l })))
  const pts = all.map((x) => x.p).sort((a, b) => a[0] - b[0])
  const box = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ p: [number, number]; l: string } | null>(null)
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
  const path = (ps: [number, number][]) => segments(ps).map((seg) => seg.map((p, k) => `${k ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' '))
  const last = all.reduce((a, b) => (b.p[0] > a.p[0] ? b : a))
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = box.current!.getBoundingClientRect()
    const t = start + ((e.clientX - r.left) / r.width) * span
    let best = all[0]
    for (const x of all) if (Math.abs(x.p[0] - t) < Math.abs(best.p[0] - t)) best = x
    setHover({ p: best.p, l: best.l.label })
  }
  const shownX = hover ?? { p: last.p, l: last.l.label }
  const shown = shownX.p
  return (
    <figure className="tchart">
      <figcaption>
        <span className="tchart-label">{label}</span>
        <span className="tchart-read">
          {shownX.l && <small className="muted">{shownX.l} </small>}{fmt(shown[1])} <small className="muted">{hover ? formatLocal(new Date(shown[0]).toISOString()) : 'latest'}</small>
        </span>
      </figcaption>
      <div className="tchart-plot" ref={box} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        <span className="tchart-y top">{fmt(y1)}</span>
        <span className="tchart-y bottom">{fmt(y0)}</span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
          aria-label={`${label}: ${pts.length} reports, from ${fmt(Math.min(...ys))} to ${fmt(Math.max(...ys))}, latest ${fmt(last.p[1])}`}>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} className="tchart-grid" x1={0} x2={W} y1={H * f} y2={H * f} />)}
          {lines0.map((l, j) => path(l.pts).map((d, k) => <path key={`${j}-${k}`} d={d} className="tchart-line" style={{ stroke: l.color }} vectorEffect="non-scaling-stroke" />))}
          {lines0.map((l, j) => l.pts.length <= 40 && l.pts.map((p) => <circle key={`${j}-${p[0]}`} cx={sx(p[0])} cy={sy(p[1])} r={1.6} className="tchart-dot" style={{ fill: l.color }} vectorEffect="non-scaling-stroke" />))}
          {hover && <line className="tchart-cursor" x1={sx(hover.p[0])} x2={sx(hover.p[0])} y1={0} y2={H} vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      {series && series.length > 1 && (
        <div className="tchart-legend">
          {lines0.map((l) => <span key={l.label}><i style={{ background: l.color }} />{l.label} <small className="muted">({l.pts.length})</small></span>)}
        </div>
      )}
      <div className="tchart-x muted">
        <span>{short.format(start)}</span>
        <span>{short.format(start + span / 2)}</span>
        <span>{short.format(end)}</span>
      </div>
    </figure>
  )
}
