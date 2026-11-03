// The sun's height above the horizon, for shading night on charts (D-133).
// A low-precision solar position (Astronomical Almanac), good to about 0.1°
// over this century: plenty for telling day from night.

const RAD = Math.PI / 180
const J2000 = Date.UTC(2000, 0, 1, 12)

/** The sun's elevation in degrees at a place and time (ms). */
export function sunElevation(lat: number, lon: number, t: number): number {
  const n = (t - J2000) / 86_400_000
  const L = 280.46 + 0.9856474 * n
  const g = (357.528 + 0.9856003 * n) * RAD
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD
  const eps = (23.439 - 0.0000004 * n) * RAD
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda))
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda))
  const gmst = (18.697374558 + 24.06570982441908 * n) * 15 * RAD
  const ha = gmst + lon * RAD - ra
  const phi = lat * RAD
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha)) / RAD
}

/** Sunset and sunrise: the sun's upper edge on the horizon, with refraction. */
const HORIZON = -0.833
const STEP = 5 * 60_000

/** The intervals [from, to] in [start, end) when the sun is down, to 5 minutes. */
export function nights(lat: number, lon: number, start: number, end: number): [number, number][] {
  const out: [number, number][] = []
  let from: number | null = null
  for (let t = start; t < end + STEP; t += STEP) {
    const dark = sunElevation(lat, lon, Math.min(t, end)) < HORIZON
    if (dark && from === null) from = Math.min(t, end)
    if ((!dark || t >= end) && from !== null) {
      if (Math.min(t, end) > from) out.push([from, Math.min(t, end)])
      from = null
    }
  }
  return out
}
