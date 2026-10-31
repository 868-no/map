// Coarse locations for unpositioned nodes from direct links to positioned
// anchors (spec §8): a port of backend internal/geo. Estimates carry explicit
// uncertainty; underdetermined cases yield nothing.
import type { Estimate } from '../api/types'
import { iso } from './graph'

export interface Anchor {
  node: number
  lat: number
  lon: number
  errM: number // how far the true position may be from the reported one
}

/** Worst-case error of a position reported with the given precision bits: half the cell diagonal. */
export function precisionErrorM(bits: number, lat: number): number {
  if (bits >= 32) return 0
  const cellDeg = 1e-7 * 2 ** (32 - bits)
  const halfLat = (cellDeg / 2) * 111_320
  const halfLon = halfLat * Math.cos((lat * Math.PI) / 180)
  return Math.hypot(halfLat, halfLon)
}

export interface Measurement {
  anchor: number
  snr?: number // dB
  rssi?: number // dBm
  samples: number
  first: number
  last: number
}

export interface Calibration {
  p0_dbm: number
  path_loss_exponent: number
}

export interface GeoParams {
  minAnchors: number
  minSamples: number
  minAnchorSpacingM: number
  minSpreadM: number
  minShapeRatio: number
  maxAnchorDistanceM: number
  floorM: number
  uncalibratedFloorM: number
  calibration?: Calibration
}

export const defaultGeoParams: GeoParams = {
  minAnchors: 3, minSamples: 5, minAnchorSpacingM: 200, minSpreadM: 500, minShapeRatio: 0.2,
  maxAnchorDistanceM: 150_000, floorM: 500, uncalibratedFloorM: 2000,
}

export class Rejection extends Error {}

const fmt0 = (v: number) => Math.round(v).toString()

class ENU {
  kx: number
  ky: number
  constructor(public lat0: number, public lon0: number) {
    const R = 6371008.8
    this.kx = ((R * Math.cos((lat0 * Math.PI) / 180) * Math.PI) / 180)
    this.ky = (R * Math.PI) / 180
  }
  to(lat: number, lon: number): [number, number] {
    return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky]
  }
  from(x: number, y: number): [number, number] {
    return [this.lat0 + y / this.ky, this.lon0 + x / this.kx]
  }
}

interface Pt {
  x: number
  y: number
  m: Measurement
  a: Anchor
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]
const roundAway = (v: number) => Math.sign(v) * Math.round(Math.abs(v))

/** Estimate one target; throws Rejection with the reason when it cannot. */
export function locate(anchors: Map<number, Anchor>, ms: Measurement[], p: GeoParams, nodeId: (n: number) => string): Estimate {
  let pts: Pt[] = []
  for (const m of ms) {
    const a = anchors.get(m.anchor)
    if (a && m.samples > 0) pts.push({ x: 0, y: 0, m, a })
  }
  if (pts.length < p.minAnchors) throw new Rejection(`only ${pts.length} positioned anchors with direct links (need ${p.minAnchors})`)
  const e = new ENU(median(pts.map((q) => q.a.lat)), median(pts.map((q) => q.a.lon)))
  let dropped = 0
  pts = pts.filter((q) => {
    ;[q.x, q.y] = e.to(q.a.lat, q.a.lon)
    if (Math.hypot(q.x, q.y) > p.maxAnchorDistanceM) {
      dropped++
      return false
    }
    return true
  })
  if (pts.length < p.minAnchors) throw new Rejection(`inconsistent anchors: ${dropped} implausibly distant from the rest`)
  const samples = pts.reduce((n, q) => n + q.m.samples, 0)
  if (samples < p.minSamples) throw new Rejection(`only ${samples} independent samples (need ${p.minSamples})`)
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < p.minAnchorSpacingM) {
        throw new Rejection(`anchors ${nodeId(pts[i].a.node)} and ${nodeId(pts[j].a.node)} are collocated (< ${fmt0(p.minAnchorSpacingM)} m apart)`)
      }
    }
  }
  const n = pts.length
  const cx = pts.reduce((s, q) => s + q.x, 0) / n
  const cy = pts.reduce((s, q) => s + q.y, 0) / n
  let sxx = 0, syy = 0, sxy = 0
  for (const q of pts) {
    const dx = q.x - cx, dy = q.y - cy
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  sxx /= n
  syy /= n
  sxy /= n
  const tr = sxx + syy, det = sxx * syy - sxy * sxy
  const disc = Math.sqrt(Math.max((tr * tr) / 4 - det, 0))
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc
  if (Math.sqrt(tr) < p.minSpreadM) throw new Rejection(`anchors clustered (spread ${fmt0(Math.sqrt(tr))} m < ${fmt0(p.minSpreadM)} m)`)
  if (l1 <= 0 || Math.sqrt(Math.max(l2, 0) / l1) < p.minShapeRatio) throw new Rejection('anchors nearly collinear: position not constrained in two dimensions')

  let from = 0, to = 0
  const names: string[] = []
  for (const q of pts) {
    names.push(nodeId(q.a.node))
    if (from === 0 || q.m.first < from) from = q.m.first
    if (q.m.last > to) to = q.m.last
  }
  names.sort()
  const reasons: string[] = []
  let x = 0, y = 0, unc: number
  let method: Estimate['method'], quality: Estimate['quality']
  if (p.calibration && pts.filter((q) => q.m.rssi != null).length >= p.minAnchors) {
    ;[x, y, unc] = wls(pts, p.calibration, cx, cy)
    method = 'log_distance_wls'
    quality = 'low'
    reasons.push('calibrated log-distance model on RSSI; terrain and antennas still dominate error')
    unc = Math.max(unc, p.floorM)
  } else {
    // Uncalibrated: SNR-weighted centroid; it claims nothing finer than "among these anchors".
    let sw = 0
    for (const q of pts) {
      let w = q.m.samples
      if (q.m.snr != null) w *= 10 ** (Math.max(Math.min(q.m.snr, 15), -20) / 20)
      x += w * q.x
      y += w * q.y
      sw += w
    }
    x /= sw
    y /= sw
    const md = pts.reduce((s, q) => s + Math.hypot(q.x - x, q.y - y), 0)
    unc = Math.max(md / n, p.uncalibratedFloorM)
    method = 'weighted_centroid'
    quality = 'very_low'
    reasons.push('uncalibrated: weighted centroid of anchors heard directly; SNR does not measure distance')
  }
  if (dropped > 0) reasons.push(`${dropped} distant anchor(s) ignored as inconsistent`)
  // Anchors' reported positions may be off by up to errM; added in full.
  const anchorErr = pts.reduce((mx, q) => Math.max(mx, q.a.errM), 0)
  if (anchorErr > 0) {
    unc += anchorErr
    reasons.push(`radius includes up to ${fmt0(roundAway(anchorErr / 100) * 100)} m of anchor position imprecision`)
  }
  const [lat, lon] = e.from(x, y)
  return {
    // Never report finer than ~100 m in coordinates.
    lat: roundAway(lat * 1000) / 1000, lon: roundAway(lon * 1000) / 1000,
    uncertainty_radius_m: roundAway(unc / 100) * 100, method, quality,
    anchor_count: n, sample_count: samples, anchors: names, evidence_from: iso(from), evidence_to: iso(to), reasons,
  }
}

/** Levenberg-Marquardt on range residuals from the log-distance model with Huber weights. */
function wls(pts: Pt[], c: Calibration, x0: number, y0: number): [number, number, number] {
  if (c.path_loss_exponent <= 0) throw new Rejection('invalid calibration exponent')
  const os = pts
    .filter((q) => q.m.rssi != null)
    .map((q) => ({ x: q.x, y: q.y, r: 10 ** ((c.p0_dbm - q.m.rssi!) / (10 * c.path_loss_exponent)), w: Math.sqrt(q.m.samples) }))
  const cost = (x: number, y: number) => os.reduce((s, o) => s + o.w * (Math.hypot(x - o.x, y - o.y) - o.r) ** 2, 0)
  let x = x0, y = y0, lambda = 1e-3, cur = cost(x, y)
  for (let iter = 0; iter < 100; iter++) {
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0
    for (const o of os) {
      const dx = x - o.x, dy = y - o.y
      const d = Math.max(Math.hypot(dx, dy), 1)
      const res = d - o.r
      const k = 0.5 * o.r
      const w = o.w * (Math.abs(res) > k ? k / Math.abs(res) : 1)
      const jx = dx / d, jy = dy / d
      a11 += w * jx * jx
      a12 += w * jx * jy
      a22 += w * jy * jy
      b1 -= w * jx * res
      b2 -= w * jy * res
    }
    const m11 = a11 * (1 + lambda) + 1e-9, m22 = a22 * (1 + lambda) + 1e-9
    const det = m11 * m22 - a12 * a12
    if (Math.abs(det) < 1e-12) {
      lambda *= 10
      continue
    }
    let dx = (m22 * b1 - a12 * b2) / det, dy = (m11 * b2 - a12 * b1) / det
    const step = Math.hypot(dx, dy)
    if (step > 5000) {
      dx = (dx * 5000) / step
      dy = (dy * 5000) / step
    }
    const nc = cost(x + dx, y + dy)
    if (nc < cur) {
      x += dx
      y += dy
      cur = nc
      lambda = Math.max(lambda / 3, 1e-7)
      if (Math.hypot(dx, dy) < 1) break
    } else {
      lambda *= 4
      if (lambda > 1e6) break
    }
  }
  const maxR = os.reduce((m, o) => Math.max(m, o.r + Math.hypot(o.x - x0, o.y - y0)), 0)
  if (Math.hypot(x - x0, y - y0) > maxR) throw new Rejection('calibrated fit did not converge to a plausible location')
  let ssDB = 0, meanR = 0
  for (const o of os) {
    const d = Math.max(Math.hypot(x - o.x, y - o.y), 1)
    const obsDB = c.p0_dbm - 10 * c.path_loss_exponent * Math.log10(o.r)
    const predDB = c.p0_dbm - 10 * c.path_loss_exponent * Math.log10(d)
    ssDB += (obsDB - predDB) ** 2
    meanR += o.r
  }
  meanR /= os.length
  const sigma = Math.max(Math.sqrt(ssDB / os.length), 6)
  return [x, y, meanR * (10 ** (sigma / (10 * c.path_loss_exponent)) - 1)]
}
