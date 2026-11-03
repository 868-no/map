import { describe, expect, it } from 'vitest'
import { nights, sunElevation } from '../src/lib/sun'

const at = (iso: string) => Date.parse(iso)
// Trondheim
const LAT = 63.43, LON = 10.4

describe('sun (D-133)', () => {
  it('is high at a midsummer noon and below the horizon at a midwinter midnight', () => {
    // Noon in Trondheim is about 11:20 UTC; the midsummer sun peaks at 90 - 63.43 + 23.44 ≈ 50°.
    expect(sunElevation(LAT, LON, at('2026-06-21T11:18:00Z'))).toBeCloseTo(50, 0)
    expect(sunElevation(LAT, LON, at('2026-12-21T23:18:00Z'))).toBeLessThan(-40)
  })

  it('finds the night between sunset and sunrise', () => {
    // 3 November in Trondheim: sunset about 14:55 UTC, sunrise next day about 07:05 UTC.
    const n = nights(LAT, LON, at('2026-11-03T12:00:00Z'), at('2026-11-04T12:00:00Z'))
    expect(n).toHaveLength(1)
    expect(Math.abs(n[0][0] - at('2026-11-03T14:55:00Z'))).toBeLessThan(20 * 60_000)
    expect(Math.abs(n[0][1] - at('2026-11-04T07:05:00Z'))).toBeLessThan(20 * 60_000)
  })

  it('has no night at midsummer in Tromsø, and only night at midwinter', () => {
    expect(nights(69.65, 18.96, at('2026-06-21T00:00:00Z'), at('2026-06-22T00:00:00Z'))).toEqual([])
    const day = [at('2026-12-21T00:00:00Z'), at('2026-12-22T00:00:00Z')] as const
    expect(nights(69.65, 18.96, ...day)).toEqual([[day[0], day[1]]])
  })
})
