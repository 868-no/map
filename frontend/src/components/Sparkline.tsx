/** Minimal accessible SVG sparkline for in-window telemetry series. */
export function Sparkline({ label, points }: { label: string; points: [number, number | null][] }) {
  const pts = points.filter((p): p is [number, number] => p[1] !== null)
  if (pts.length < 2) return null
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const y0 = Math.min(...ys), y1 = Math.max(...ys)
  const sx = (x: number) => ((x - x0) / Math.max(x1 - x0, 1)) * 200
  const sy = (y: number) => 36 - ((y - y0) / Math.max(y1 - y0, 1e-9)) * 32
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ')
  return (
    <figure className="spark">
      <svg viewBox="0 0 200 40" role="img" aria-label={`${label}: ${ys[0].toFixed(1)} to ${ys[ys.length - 1].toFixed(1)}`}>
        <path d={d} fill="none" style={{ stroke: 'var(--accent)' }} strokeWidth="1.5" />
      </svg>
      <figcaption>
        {label}: {y0.toFixed(1)}–{y1.toFixed(1)} (last {ys[ys.length - 1].toFixed(1)})
      </figcaption>
    </figure>
  )
}
