// Bars per period for the trends pane (D-104), with an optional highlighted
// part of each bar (e.g. new nodes among those heard) and a hover readout.
import { useState } from 'react'

export interface Bar {
  label: string // the period, as shown
  value: number
  part?: number // highlighted share of the bar, drawn from its base
}

export function BarChart({ title, bars, partLabel, note }: { title: string; bars: Bar[]; partLabel?: string; note?: string }) {
  const [hover, setHover] = useState<number | null>(null)
  if (bars.length === 0) return null
  const max = Math.max(1, ...bars.map((b) => b.value))
  const shown = bars[hover ?? bars.length - 1]
  const w = 100 / bars.length
  return (
    <figure className="bchart">
      <figcaption>
        <span className="tchart-label" title={note}>{title}</span>
        <span className="tchart-read">
          {shown.value.toLocaleString()}
          {partLabel && shown.part !== undefined && <small className="muted"> · {shown.part.toLocaleString()} {partLabel}</small>}
          <small className="muted"> {shown.label}</small>
        </span>
      </figcaption>
      <div className="bchart-plot" onPointerLeave={() => setHover(null)}>
        <span className="tchart-y top">{max.toLocaleString()}</span>
        <svg viewBox="0 0 100 60" preserveAspectRatio="none" role="img" aria-label={`${title}: ${bars.map((b) => `${b.label} ${b.value}`).join(', ')}`}>
          {bars.map((b, k) => {
            const h = (b.value / max) * 56
            const ph = b.part !== undefined ? (Math.min(b.part, b.value) / max) * 56 : 0
            return (
              <g key={k} onPointerEnter={() => setHover(k)} onPointerDown={() => setHover(k)}>
                <rect x={k * w} y={0} width={w} height={60} fill="transparent" />
                <rect x={k * w + w * 0.12} y={60 - h} width={w * 0.76} height={h} className={`bchart-bar${hover === k ? ' on' : ''}`} />
                {ph > 0 && <rect x={k * w + w * 0.12} y={60 - ph} width={w * 0.76} height={ph} className="bchart-part" />}
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
      {partLabel && <div className="tchart-legend"><span><i className="bchart-key" />all</span><span><i className="bchart-key part" />{partLabel}</span></div>}
    </figure>
  )
}
