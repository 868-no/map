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

/**
 * A quantity drawn behind the lines (D-133): a `level` on the chart's own
 * axis, as a shaded area; a `share` as a shaded area on a fixed scale of its
 * own (`domain`); or an hourly `amount` as bars from the bottom on a scale of
 * their own.
 */
export interface Band {
  label: string
  unit: string
  color: string // CSS colour
  kind: 'level' | 'share' | 'amount'
  points: [number, number][] // [ms, value]; for amounts, the end of the hour
  domain?: [number, number] // shares: the scale, default 0–100
  decimals?: number
  note?: string // shown under the chart, e.g. its source
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
  /** Drawn behind the lines; the chart shows it alone when no line has a value. */
  band?: Band
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

const HOUR = 3_600_000

export function TimeChart({ label, unit, points, series, start, end, decimals = 1, domain, empty, band }: TimeChartProps) {
  const lines0 = (series ?? [{ label: '', color: 'var(--accent)', points: points ?? [] }]).map((l) => ({ ...l, pts: clean(l.points) }))
  const all = lines0.flatMap((l) => l.pts.map((p) => ({ p, l })))
  const pts = all.map((x) => x.p).sort((a, b) => a[0] - b[0])
  const box = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ p: [number, number]; l: string } | null>(null)
  const bpts = band ? clean(band.points).filter((p) => p[0] > start - HOUR && p[0] <= end + HOUR) : []
  if (pts.length === 0 && bpts.length === 0) return empty ? <p className="muted small">{label}: {empty}</p> : null
  // A level shares the axis; with no lines, the band is what is read off.
  const level = band?.kind === 'level'
  const onlyBand = pts.length === 0
  const ys = [...pts.map((p) => p[1]), ...(level || onlyBand ? bpts.map((p) => p[1]) : [])]
  const share = band?.kind === 'share' ? (band.domain ?? [0, 100]) : undefined
  const fixed = onlyBand && share ? share : domain
  let [y0, y1] = fixed ?? [Math.min(...ys), Math.max(...ys)]
  if (!fixed) {
    const pad = Math.max((y1 - y0) * 0.1, 10 ** -decimals)
    // Quantities that cannot be negative (percentages, durations) never get a negative axis.
    y0 = unit === '%' || unit === 'days' || unit === 'm/s' ? Math.max(0, y0 - pad) : y0 - pad
    y1 += pad
  }
  const span = Math.max(end - start, 1)
  const sx = (t: number) => ((t - start) / span) * W
  const sy = (v: number) => H - ((Math.min(Math.max(v, y0), y1) - y0) / Math.max(y1 - y0, 1e-9)) * H
  const fmtIn = (v: number, u: string, d: number) => `${v.toFixed(d)}${u === '%' ? ' %' : u ? ` ${u}` : ''}`
  const fmt = (v: number) => fmtIn(v, unit, decimals)
  const fmtBand = (v: number) => fmtIn(v, band!.unit, band!.decimals ?? decimals)
  const bmax = Math.max(...bpts.map((p) => p[1]), 1) // amounts: a drizzle stays small
  const by = (v: number) =>
    level || onlyBand ? sy(v)
    : share ? H - ((Math.min(Math.max(v, share[0]), share[1]) - share[0]) / (share[1] - share[0])) * H
    : H - (Math.max(v, 0) / bmax) * H * 0.9
  // The band's value at a time: the hour holding it (amounts) or the nearest within an hour.
  const bandAt = (t: number) => {
    let best: [number, number] | undefined
    for (const p of bpts) {
      const d = band!.kind === 'amount' ? (t <= p[0] && t > p[0] - HOUR ? 0 : Infinity) : Math.abs(p[0] - t)
      if (d <= HOUR && (!best || d < Math.abs(best[0] - t))) best = p
    }
    return best
  }
  const path = (ps: [number, number][]) => segments(ps).map((seg) => seg.map((p, k) => `${k ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' '))
  const read = onlyBand ? bpts.map((p) => ({ p, l: { label: band!.label } })) : all
  const last = read.reduce((a, b) => (b.p[0] > a.p[0] ? b : a))
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = box.current!.getBoundingClientRect()
    const t = start + ((e.clientX - r.left) / r.width) * span
    let best = read[0]
    for (const x of read) if (Math.abs(x.p[0] - t) < Math.abs(best.p[0] - t)) best = x
    setHover({ p: best.p, l: best.l.label })
  }
  const shownX = hover ?? { p: last.p, l: last.l.label }
  const shown = shownX.p
  const bandShown = band && !onlyBand ? bandAt(shown[0]) : undefined
  const bandPath = (() => {
    if (!band || bpts.length === 0) return ''
    if (band.kind === 'amount') {
      const w = (HOUR / span) * W
      return bpts.filter((p) => p[1] > 0).map((p) => `M${(sx(p[0]) - w).toFixed(1)},${H}V${by(p[1]).toFixed(1)}h${w.toFixed(2)}V${H}Z`).join('')
    }
    return segments(bpts).filter((seg) => seg.length > 0).map((seg) =>
      `M${sx(seg[0][0]).toFixed(1)},${H}` + seg.map((p) => `L${sx(p[0]).toFixed(1)},${by(p[1]).toFixed(1)}`).join('') + `L${sx(seg[seg.length - 1][0]).toFixed(1)},${H}Z`).join('')
  })()
  return (
    <figure className="tchart">
      <figcaption>
        <span className="tchart-label">{label}</span>
        <span className="tchart-read">
          {shownX.l && <small className="muted">{shownX.l} </small>}{onlyBand ? fmtBand(shown[1]) : fmt(shown[1])}
          {bandShown && <small className="muted"> · {band!.label} {fmtBand(bandShown[1])}</small>}{' '}
          <small className="muted">{hover ? formatLocal(new Date(shown[0]).toISOString()) : 'latest'}</small>
        </span>
      </figcaption>
      <div className="tchart-plot" ref={box} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        <span className="tchart-y top">{onlyBand ? fmtBand(y1) : fmt(y1)}</span>
        <span className="tchart-y bottom">{onlyBand ? fmtBand(y0) : fmt(y0)}</span>
        {band?.kind === 'amount' && !onlyBand && bpts.length > 0 && <span className="tchart-y top band" style={{ color: band.color }}>{fmtBand(bmax)}</span>}
        {share && !onlyBand && bpts.length > 0 && <span className="tchart-y top band" style={{ color: band!.color }}>{fmtBand(share[1])}</span>}
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
          aria-label={onlyBand ? `${label}: ${band!.label} only, ${bpts.length} hours, from ${fmtBand(Math.min(...ys))} to ${fmtBand(Math.max(...ys))}`
            : `${label}: ${pts.length} reports, from ${fmt(Math.min(...pts.map((p) => p[1])))} to ${fmt(Math.max(...pts.map((p) => p[1])))}, latest ${fmt(last.p[1])}${band ? `, with ${band.label}` : ''}`}>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} className="tchart-grid" x1={0} x2={W} y1={H * f} y2={H * f} />)}
          {bandPath && <path d={bandPath} className={`tchart-band ${band!.kind}`} style={{ fill: band!.color }} />}
          {lines0.map((l, j) => path(l.pts).map((d, k) => <path key={`${j}-${k}`} d={d} className="tchart-line" style={{ stroke: l.color }} vectorEffect="non-scaling-stroke" />))}
          {lines0.map((l, j) => l.pts.length <= 40 && l.pts.map((p) => <circle key={`${j}-${p[0]}`} cx={sx(p[0])} cy={sy(p[1])} r={1.6} className="tchart-dot" style={{ fill: l.color }} vectorEffect="non-scaling-stroke" />))}
          {hover && <line className="tchart-cursor" x1={sx(hover.p[0])} x2={sx(hover.p[0])} y1={0} y2={H} vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      {((series && series.length > 1) || (band && bpts.length > 0)) && (
        <div className="tchart-legend">
          {series && series.length > 1 && lines0.map((l) => <span key={l.label}><i style={{ background: l.color }} />{l.label} <small className="muted">({l.pts.length})</small></span>)}
          {band && bpts.length > 0 && <span><i className="band" style={{ background: band.color }} />{band.label}</span>}
          {band?.note && bpts.length > 0 && <small className="muted">{band.note}</small>}
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
