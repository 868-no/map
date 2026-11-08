// A telemetry time series over the selected period (D-100): the x axis is the
// whole window, so charts of one node line up and gaps show when it was
// silent. Hovering (or touching) reads off the nearest report; charts in one
// ChartGroup all read off the same moment.
import { createContext, useContext, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { formatLocal } from '../lib/time'

const W = 300, H = 80 // viewBox units; the plot stretches to the panel width

/** One line of a chart with several (D-105). */
export interface Series {
  label: string
  color: string // CSS colour
  points: [number, number | null][]
  /** Readings behind each point, by its time (binned series, D-197): read out on hover, summed in the legend. */
  counts?: ReadonlyMap<number, number>
  /** Drawn dashed: a reference beside the measured lines (a noise floor, D-199). */
  dashed?: boolean
}

/** Lines in another unit than the chart's, on a scale of their own read at the right edge (D-199). */
export interface RightAxis {
  unit: string
  decimals?: number
  series: Series[]
}

/**
 * A quantity drawn behind the lines (D-133): a `level` on the chart's own
 * axis, as a shaded area; a `share` as a shaded area on a scale of its own
 * (`domain`, else from 0 to its largest value); or an hourly `amount` as bars
 * from the bottom on a scale of their own.
 */
export interface Band {
  label: string
  unit: string
  color: string // CSS colour
  kind: 'level' | 'share' | 'amount'
  points: [number, number][] // [ms, value]; for amounts, the end of the hour
  domain?: [number, number] // shares: the scale
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
  /** Drawn behind the lines, first beneath; the chart shows them alone when no line has a value. */
  bands?: (Band | undefined)[]
  /** Intervals [from, to] (ms) shaded as night, over the bands and under the lines. */
  nights?: [number, number][]
  /** Lines on a second scale at the right; they never make a chart show on their own. */
  right?: RightAxis
}

/** The moment (ms) being inspected in a group of charts, shared by all of them. */
const Sync = createContext<{ t: number | null; set: (t: number | null) => void } | null>(null)

/** Charts that inspect one moment together: hovering one shows the same time in all. */
export function ChartGroup({ children }: { children: ReactNode }) {
  const [t, set] = useState<number | null>(null)
  const value = useMemo(() => ({ t, set }), [t])
  return <Sync.Provider value={value}><div className="tcharts">{children}</div></Sync.Provider>
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

/** The readings behind a point read off a chart, when its series counts them. */
const countOf = (x: { p: [number, number]; l: { label: string; counts?: ReadonlyMap<number, number> } }) => x.l.counts?.get(x.p[0])

const fmtIn = (v: number, u: string, d: number) => `${v.toFixed(d)}${u === '%' ? ' %' : u ? ` ${u}` : ''}`

type Prepared = NonNullable<ReturnType<typeof prepare>>

/**
 * Everything about a chart that depends on its data alone, the plot's paths
 * included: computed once per data change, not on every pointer move (a
 * group's charts all re-render while one is hovered).
 */
function prepare({ label, unit, points, series, start, end, decimals = 1, domain, bands: bands0, nights, right }: TimeChartProps) {
  const lines0 = (series ?? [{ label: '', color: 'var(--accent)', points: points ?? [] }]).map((l) => ({ ...l, pts: clean(l.points), right: false }))
  const all = lines0.flatMap((l) => l.pts.map((p) => ({ p, l })))
  const linesR = (right?.series ?? []).map((l) => ({ ...l, pts: clean(l.points), right: true })).filter((l) => l.pts.length > 0)
  const pts = all.map((x) => x.p).sort((a, b) => a[0] - b[0])
  const bands = (bands0 ?? []).filter((b): b is Band => !!b)
    .map((b) => ({ ...b, pts: clean(b.points).filter((p) => p[0] > start - HOUR && p[0] <= end + HOUR) }))
    .filter((b) => b.pts.length > 0)
  if (pts.length === 0 && bands.length === 0) return null
  // With no lines, the first band is what the axis and readout show.
  const onlyBand = pts.length === 0
  const main = onlyBand ? bands[0] : undefined
  type B = (typeof bands)[number]
  const onAxis = (b: B) => b.kind === 'level' || b === main
  const ys = [...pts.map((p) => p[1]), ...bands.filter(onAxis).flatMap((b) => b.pts.map((p) => p[1]))]
  const fixed = main && main.kind === 'share' && main.domain ? main.domain : domain
  let [y0, y1] = fixed ?? [Math.min(...ys), Math.max(...ys)]
  if (!fixed) {
    const pad = Math.max((y1 - y0) * 0.1, 10 ** -decimals)
    // Quantities that cannot be negative (percentages, durations) never get a negative axis.
    y0 = ['%', 'days', 'm/s', 'W/m²'].includes(main?.unit ?? unit) ? Math.max(0, y0 - pad) : y0 - pad
    y1 += pad
  }
  const span = Math.max(end - start, 1)
  const sx = (t: number) => ((t - start) / span) * W
  const sy = (v: number) => H - ((Math.min(Math.max(v, y0), y1) - y0) / Math.max(y1 - y0, 1e-9)) * H
  const fmtB = (b: Band, v: number) => fmtIn(v, b.unit, b.decimals ?? decimals)
  const fmt = (v: number) => (main ? fmtB(main, v) : fmtIn(v, unit, decimals))
  // The right-hand scale: its lines' own range, with the same margin.
  const ysR = linesR.flatMap((l) => l.pts.map((p) => p[1]))
  const decR = right?.decimals ?? decimals
  const padR = ysR.length ? Math.max((Math.max(...ysR) - Math.min(...ysR)) * 0.1, 10 ** -decR) : 0
  const [r0, r1] = ysR.length ? [Math.min(...ysR) - padR, Math.max(...ysR) + padR] : [0, 1]
  const sr = (v: number) => H - ((Math.min(Math.max(v, r0), r1) - r0) / Math.max(r1 - r0, 1e-9)) * H
  const fmtR = (v: number) => fmtIn(v, right?.unit ?? '', decR)
  const allR = linesR.flatMap((l) => l.pts.map((p) => ({ p, l })))
  // A band off the axis has a scale of its own: its domain, else 0 to its largest value.
  const scale = (b: B): [number, number] => b.domain ?? [0, Math.max(...b.pts.map((p) => p[1]), b.kind === 'amount' ? 1 : 1e-9)]
  const by = (b: B, v: number) => {
    if (onAxis(b)) return sy(v)
    const [lo, hi] = scale(b)
    const f = (Math.min(Math.max(v, lo), hi) - lo) / Math.max(hi - lo, 1e-9)
    return H - f * H * (b.kind === 'amount' ? 0.9 : 1)
  }
  // A band's value at a time: the hour holding it (amounts) or the nearest within an hour.
  const bandAt = (b: B, t: number) => {
    let best: [number, number] | undefined
    for (const p of b.pts) {
      const d = b.kind === 'amount' ? (t <= p[0] && t > p[0] - HOUR ? 0 : Infinity) : Math.abs(p[0] - t)
      if (d <= HOUR && (!best || d < Math.abs(best[0] - t))) best = p
    }
    return best
  }
  const path = (ps: [number, number][], y = sy) => segments(ps).map((seg) => seg.map((p, k) => `${k ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' '))
  const own = main ? main.pts.map((p) => ({ p, l: { label: main.label, right: false } as { label: string; right: boolean; counts?: ReadonlyMap<number, number> } })) : all
  // The latest reading shown is the chart's own; the right-hand lines are read on hover.
  const last = own.reduce((a, b) => (b.p[0] > a.p[0] ? b : a))
  const read = [...own, ...allR]
  const bandPath = (b: B) => {
    if (b.kind === 'amount') {
      const w = (HOUR / span) * W
      return b.pts.filter((p) => p[1] > 0).map((p) => `M${(sx(p[0]) - w).toFixed(1)},${H}V${by(b, p[1]).toFixed(1)}h${w.toFixed(2)}V${H}Z`).join('')
    }
    return segments(b.pts).filter((seg) => seg.length > 0).map((seg) =>
      `M${sx(seg[0][0]).toFixed(1)},${H}` + seg.map((p) => `L${sx(p[0]).toFixed(1)},${by(b, p[1]).toFixed(1)}`).join('') + `L${sx(seg[seg.length - 1][0]).toFixed(1)},${H}Z`).join('')
  }
  const offAxis = bands.filter((b) => !onAxis(b))
  const notes = [...new Set(bands.map((b) => b.note).filter((n): n is string => !!n))]
  const rightAria = linesR.length ? `, with ${linesR.map((l) => l.label).join(' and ')} on a scale of its own from ${fmtR(Math.min(...ysR))} to ${fmtR(Math.max(...ysR))}` : ''
  const ariaLabel = main ? `${label}: ${main.label} only, ${main.pts.length} hours, from ${fmt(Math.min(...ys))} to ${fmt(Math.max(...ys))}`
    : `${label}: ${pts.length} reports, from ${fmt(Math.min(...pts.map((p) => p[1])))} to ${fmt(Math.max(...pts.map((p) => p[1])))}, latest ${fmt(last.p[1])}${bands.length ? `, with ${bands.map((b) => b.label).join(' and ')}` : ''}${rightAria}`
  const plot = (
    <>
      {[0.25, 0.5, 0.75].map((f) => <line key={f} className="tchart-grid" x1={0} x2={W} y1={H * f} y2={H * f} />)}
      {bands.map((b) => <path key={b.label} d={bandPath(b)} className={`tchart-band ${b.kind}`} style={{ fill: b.color }} />)}
      {/* Night dims the bands beneath it, not the lines above. */}
      {(nights ?? []).map(([a, b]) => <rect key={a} className="tchart-night" x={sx(Math.max(a, start))} y={0} width={Math.max(0, sx(Math.min(b, end)) - sx(Math.max(a, start)))} height={H} />)}
      {[...lines0, ...linesR].map((l, j) => path(l.pts, l.right ? sr : sy).map((d, k) => <path key={`${j}-${k}`} d={d} className={l.dashed ? 'tchart-line dashed' : 'tchart-line'} style={{ stroke: l.color }} vectorEffect="non-scaling-stroke" />))}
      {[...lines0, ...linesR].map((l, j) => l.pts.length <= 40 && l.pts.map((p) => <circle key={`${j}-${p[0]}`} cx={sx(p[0])} cy={(l.right ? sr : sy)(p[1])} r={1.6} className="tchart-dot" style={{ fill: l.color }} vectorEffect="non-scaling-stroke" />))}
    </>
  )
  return { lines0, linesR, bands, main, y0, y1, r0, r1, span, sx, fmt, fmtR, fmtB, scale, bandAt, read, last, offAxis, notes, ariaLabel, plot }
}

export function TimeChart(props: TimeChartProps) {
  const { label, series, start, end, empty, nights } = props
  const box = useRef<HTMLDivElement>(null)
  // The moment inspected: the group's, or this chart's own outside a group.
  const sync = useContext(Sync)
  const [ownT, setOwnT] = useState<number | null>(null)
  const t = sync ? sync.t : ownT
  const setT = sync ? sync.set : setOwnT
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const g: Prepared | null = useMemo(() => prepare(props), [props.label, props.unit, props.points, props.series, props.start, props.end, props.decimals, props.domain, props.bands, props.nights, props.right])
  if (!g) return empty ? <p className="muted small">{label}: {empty}</p> : null
  const { lines0, linesR, bands, main, y0, y1, r0, r1, span, sx, fmt, fmtR, fmtB, scale, bandAt, read, last, offAxis, notes } = g
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = box.current!.getBoundingClientRect()
    setT(start + (Math.min(Math.max(e.clientX - r.left, 0), r.width) / r.width) * span)
  }
  // The reading nearest the inspected moment; none when this chart has no
  // report near it (another chart of the group is being read where this one was silent).
  const near = Math.max(HOUR, span / 50)
  let hit: (typeof read)[number] | undefined
  if (t !== null) for (const x of read) if (Math.abs(x.p[0] - t) <= near && (!hit || Math.abs(x.p[0] - t) < Math.abs(hit.p[0] - t))) hit = x
  const hover = t === null ? null : hit ? { p: hit.p, l: hit.l.label, n: countOf(hit), right: hit.l.right } : { p: [t, NaN] as [number, number], l: '', n: undefined, right: false }
  const shownX = hover ?? { p: last.p, l: last.l.label, n: countOf(last), right: false }
  const shown = shownX.p
  return (
    <figure className="tchart">
      <figcaption>
        <span className="tchart-label">{label}</span>
        <span className="tchart-read">
          {shownX.l && <small className="muted">{shownX.l} </small>}{Number.isNaN(shown[1]) ? <small className="muted">no reading</small> : shownX.right ? fmtR(shown[1]) : fmt(shown[1])}
          {shownX.n !== undefined && <small className="muted"> · {shownX.n} reading{shownX.n === 1 ? '' : 's'}</small>}
          {bands.filter((b) => b !== main).map((b) => {
            const v = bandAt(b, shown[0])
            return v && <small key={b.label} className="muted"> · {b.label} {fmtB(b, v[1])}</small>
          })}{' '}
          <small className="muted tchart-at">{hover ? formatLocal(new Date(shown[0]).toISOString()) : 'latest'}</small>
        </span>
      </figcaption>
      <div className="tchart-plot" ref={box} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setT(null)}>
        <span className="tchart-y top">{fmt(y1)}</span>
        <span className="tchart-y bottom">{fmt(y0)}</span>
        {offAxis.map((b, i) => <span key={b.label} className="tchart-y top band" style={{ color: b.color, top: 2 + 12 * i }}>{fmtB(b, scale(b)[1])}</span>)}
        {linesR.length > 0 && <>
          <span className="tchart-y top band" style={{ color: linesR[0].color }}>{fmtR(r1)}</span>
          <span className="tchart-y bottom band" style={{ color: linesR[0].color }}>{fmtR(r0)}</span>
        </>}
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={g.ariaLabel}>
          {g.plot}
          {hover && <line className="tchart-cursor" x1={sx(hover.p[0])} x2={sx(hover.p[0])} y1={0} y2={H} vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      {((series && series.length > 1) || linesR.length > 0 || bands.length > 0 || !!nights?.length) && (
        <div className="tchart-legend">
          {[...(series && series.length > 1 ? lines0 : []), ...linesR].map((l) => <span key={l.label}><i className={l.dashed ? 'dashed' : undefined} style={{ color: l.color, background: l.dashed ? undefined : l.color }} />{l.label}{l.right && <small className="muted"> ({props.right?.unit}, right)</small>} <small className="muted">({l.counts ? `${[...l.counts.values()].reduce((a, b) => a + b, 0)} readings` : l.pts.length})</small></span>)}
          {bands.map((b) => <span key={b.label}><i className="band" style={{ background: b.color }} />{b.label}</span>)}
          {!!nights?.length && <span><i className="band night" />Night</span>}
          {notes.map((n) => <small key={n} className="muted">{n}</small>)}
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
