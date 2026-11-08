// Stacked bars per period, each the share of a whole (D-198): every bar
// fills the plot, split into its series, the first on top. The legend lists
// the series in the same order with the hovered period's counts and shares,
// so it is the chart's readout and its table at once.
import { useState } from 'react'

export interface StackSeries {
  key: string
  label: string
  title?: string
  color: string
}

export interface StackBar {
  label: string // the period, as shown
  total: number // the whole; the counts sum to it
  counts: number[] // per series
}

/** "37 %", or "<1 %" for a share too small to round to one. */
export function percent(n: number, total: number): string {
  if (!total || !n) return '0 %'
  const p = (100 * n) / total
  return p < 1 ? '<1 %' : `${Math.round(p)} %`
}

export function StackedBarChart({ title, note, unit, series, bars }: { title: string; note?: string; unit: [string, string]; series: StackSeries[]; bars: StackBar[] }) {
  const [hover, setHover] = useState<number | null>(null)
  if (bars.length === 0 || series.length === 0) return null
  const k = hover ?? bars.length - 1
  const shown = bars[k]
  const w = 100 / bars.length
  const of = (n: number) => `${n.toLocaleString()} ${n === 1 ? unit[0] : unit[1]}`
  return (
    <figure className="bchart schart">
      <figcaption>
        <span className="tchart-label" title={note}>{title}</span>
        <span className="tchart-read">{of(shown.total)}<small className="muted"> {shown.label}</small></span>
      </figcaption>
      <div className="schart-plot" onPointerLeave={() => setHover(null)}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
          aria-label={`${title}, share of ${unit[1]} per period: ${bars.map((b) => `${b.label}: ${series.map((s, i) => (b.counts[i] ? `${s.label} ${percent(b.counts[i], b.total)}` : '')).filter(Boolean).join(', ') || 'none'}`).join('; ')}`}>
          {bars.map((b, j) => {
            let y = 0
            return (
              <g key={j} className={`schart-col${hover !== null && hover !== j ? ' dim' : ''}`} onPointerEnter={() => setHover(j)} onPointerDown={() => setHover(j)}>
                <rect x={j * w} y={0} width={w} height={100} fill="transparent" />
                {b.total > 0 && series.map((s, i) => {
                  const h = (100 * (b.counts[i] ?? 0)) / b.total
                  if (h <= 0) return null
                  const r = <rect key={s.key} x={j * w + w * 0.1} y={y} width={w * 0.8} height={h} className="schart-seg" style={{ fill: s.color }} />
                  y += h
                  return r
                })}
              </g>
            )
          })}
        </svg>
      </div>
      <div className="tchart-x muted">
        <span>{bars[0].label}</span>
        {bars.length > 2 && <span>{bars[Math.floor(bars.length / 2)].label}</span>}
        <span>{bars[bars.length - 1].label}</span>
      </div>
      <ul className="schart-legend" aria-label={`${title}, ${shown.label}`}>
        {series.map((s, i) => (
          <li key={s.key} title={s.title}>
            <i style={{ background: s.color }} aria-hidden />
            <span className="lbl">{s.label}</span>
            <span className="n">{(shown.counts[i] ?? 0).toLocaleString()}</span>
            <span className="pct">{percent(shown.counts[i] ?? 0, shown.total)}</span>
          </li>
        ))}
      </ul>
    </figure>
  )
}
