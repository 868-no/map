import { describe, expect, it } from 'vitest'
import type { ObsRow } from '../src/api/types'
import { choosePosition } from '../src/derive/views'

const T0 = Date.parse('2026-10-31T12:00:00Z')
const row = (i: number, y: 'position' | 'mapreport', lat: number, bits: number, t: number): ObsRow => ({
  i, t: T0 + t, b: 'x', s: 1, y, l: `l${i}`, o: `o${i}`, sg: 'unsigned', po: { lat, lon: 10.7, precision_bits: bits, precision_known: bits > 0 },
})

describe('choosePosition', () => {
  const H = 3_600_000
  it.each([
    ['overlapping: the precise older packet wins', row(1, 'position', 61.2232, 32, 0), row(2, 'mapreport', 61.225, 14, H), 'position'],
    ['overlapping: the precise newer report wins', row(1, 'position', 61.2232, 13, 0), row(2, 'mapreport', 61.225, 16, H), 'mapreport'],
    ['overlapping, equal precision: newer', row(1, 'position', 61.2232, 16, H), row(2, 'mapreport', 61.2233, 16, 0), 'position'],
    ['apart (moving): newer despite lower precision', row(1, 'position', 61.0, 32, 0), row(2, 'mapreport', 61.45, 14, H), 'mapreport'],
    ['unknown precision: newer', row(1, 'position', 61.2232, 0, H), row(2, 'mapreport', 61.2232, 32, 0), 'position'],
  ])('%s', (_, a, b, want) => {
    expect(choosePosition(a, b).y).toBe(want)
    expect(choosePosition(b, a).y).toBe(want)
  })
})
