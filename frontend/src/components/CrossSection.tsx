// A link's cross section (D-143): the terrain between its ends, raised by the
// earth's curvature, the straight line between the antennas and the first
// Fresnel zone around it. Hovering a point marks it on the map's line.
import { useRef, useState, type PointerEvent } from 'react'
import type { TerrainProfile, TerrainSample } from '../api/types'
import { useStore } from '../state/store'

const W = 600
const H = 160

export const LOS_LABEL: Record<string, string> = { clear: 'clear', grazing: 'grazing', blocked: 'blocked', unknown: 'unknown' }
export const LOS_TITLE: Record<string, string> = {
  clear: 'At least 60 % of the first Fresnel zone is free of terrain along the whole path',
  grazing: 'The straight line between the antennas is free, but terrain reaches into the first Fresnel zone',
  blocked: 'Terrain cuts the straight line between the antennas',
  unknown: 'The terrain model does not cover enough of the path',
}

const km = (m: number) => (m >= 10_000 ? `${(m / 1000).toFixed(0)} km` : `${(m / 1000).toFixed(1)} km`)

/** The cross section's points, the ends included. */
function points(p: TerrainProfile): TerrainSample[] {
  const end = (d: number, lat: number, lon: number, g: number | undefined, h: number) => ({ d, lat, lon, ground: g, bulge: 0, line: h, fresnel: 0 })
  const s = p.samples ?? []
  if (!s.length || p.a.height == null || p.b.height == null) return s
  const first = s[0], last = s[s.length - 1]
  // The ends' coordinates, extrapolated from the first and last steps.
  const step = s.length > 1 ? { lat: s[1].lat - first.lat, lon: s[1].lon - first.lon } : { lat: 0, lon: 0 }
  return [end(0, first.lat - step.lat, first.lon - step.lon, p.a.ground, p.a.height), ...s, end(p.length_m, last.lat + step.lat, last.lon + step.lon, p.b.ground, p.b.height)]
}

export function CrossSection({ profile, nameA, nameB }: { profile: TerrainProfile; nameA: string; nameB: string }) {
  const setProbe = useStore((s) => s.setProbe)
  const box = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const pts = points(profile)
  if (pts.length < 3) return null
  const terrain = (q: TerrainSample) => (q.ground == null ? null : q.ground + q.bulge)
  const ys = pts.flatMap((q) => [q.line + q.fresnel, q.line - q.fresnel, ...(terrain(q) == null ? [] : [terrain(q)!])])
  let y0 = Math.min(...ys), y1 = Math.max(...ys)
  const pad = Math.max(5, (y1 - y0) * 0.06)
  y0 -= pad
  y1 += pad
  const L = profile.length_m || 1
  const sx = (d: number) => (d / L) * W
  const sy = (v: number) => H - ((v - y0) / (y1 - y0)) * H
  // Terrain as filled runs, broken where the model has no height.
  const runs: TerrainSample[][] = [[]]
  for (const q of pts) {
    if (terrain(q) != null) runs[runs.length - 1].push(q)
    else if (runs[runs.length - 1].length) runs.push([])
  }
  const ground = runs.filter((r) => r.length > 1).map((r) => `M${sx(r[0].d)},${H} ` + r.map((q) => `L${sx(q.d)},${sy(terrain(q)!)}`).join(' ') + ` L${sx(r[r.length - 1].d)},${H} Z`)
  const zone = `M${pts.map((q) => `${sx(q.d)},${sy(q.line + q.fresnel)}`).join(' L')} L${[...pts].reverse().map((q) => `${sx(q.d)},${sy(q.line - q.fresnel)}`).join(' L')} Z`
  const zone60 = `M${pts.map((q) => `${sx(q.d)},${sy(q.line - 0.6 * q.fresnel)}`).join(' L')}`
  const line = `M${sx(0)},${sy(pts[0].line)} L${sx(L)},${sy(pts[pts.length - 1].line)}`

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = box.current!.getBoundingClientRect()
    const d = (Math.min(Math.max(e.clientX - r.left, 0), r.width) / r.width) * L
    let k = 0
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].d - d) < Math.abs(pts[k].d - d)) k = i
    setHover(k)
    setProbe([pts[k].lon, pts[k].lat])
  }
  const onLeave = () => {
    setHover(null)
    setProbe(null)
  }
  const h = hover == null ? null : pts[hover]
  const free = h && h.fresnel > 0 && terrain(h) != null ? (h.line - terrain(h)!) / h.fresnel : null
  const worst = pts.find((q) => q.d === profile.worst_d)
  const antenna = (a: TerrainProfile['a'], name: string) =>
    a.height == null ? `${name}: no height` : `${name} ${Math.round(a.height)} m (${a.source === 'reported' ? 'reported altitude' : `terrain ${Math.round(a.ground ?? 0)} m + 2 m`})`
  return (
    <figure className="tchart xsection">
      <figcaption>
        <span className="tchart-label">Cross section</span>
        <span className="tchart-read">
          {h ? (
            <>
              <small className="muted">{km(h.d)} from {nameA} · </small>
              {terrain(h) == null ? <small className="muted">no terrain height</small> : <>ground {Math.round(h.ground!)} m</>}
              <small className="muted"> · line {Math.round(h.line)} m{free != null && ` · ${free >= 1 ? 'zone free' : free < 0 ? `${Math.round(terrain(h)! - h.line)} m above the line` : `${Math.round(free * 100)} % of the zone free`}`}</small>
            </>
          ) : (
            <small className="muted">{km(L)}</small>
          )}
        </span>
      </figcaption>
      <div className="tchart-plot xsection-plot" ref={box} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={onLeave}>
        <span className="tchart-y top">{Math.round(y1)} m</span>
        <span className="tchart-y bottom">{Math.round(y0)} m</span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Cross section from ${nameA} to ${nameB}: ${profile.class}`}>
          <path d={zone} className="xs-zone" />
          <path d={zone60} className="xs-zone60" vectorEffect="non-scaling-stroke" />
          {ground.map((d, i) => <path key={i} d={d} className="xs-ground" />)}
          <path d={line} className="xs-line" vectorEffect="non-scaling-stroke" />
          {worst && profile.class !== 'clear' && <line className="xs-worst" x1={sx(worst.d)} x2={sx(worst.d)} y1={0} y2={H} vectorEffect="non-scaling-stroke" />}
          {h && <line className="tchart-cursor" x1={sx(h.d)} x2={sx(h.d)} y1={0} y2={H} vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      <div className="tchart-x muted"><span>{nameA}</span><span>{nameB}</span></div>
      <div className="tchart-legend">
        <span><i className="band xs-ground-key" />Terrain, raised by the earth's curvature</span>
        <span><i style={{ background: 'var(--accent)' }} />Line of sight</span>
        <span><i className="band xs-zone-key" />First Fresnel zone (dashed: 60 %)</span>
        <small className="muted">{antenna(profile.a, nameA)} · {antenna(profile.b, nameB)} · {profile.attribution} (CC BY 4.0)</small>
      </div>
    </figure>
  )
}
