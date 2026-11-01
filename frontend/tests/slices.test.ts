import { describe, expect, it } from 'vitest'
import { cursorMs, rangeEnd, sliceBounds } from '../src/derive/slices'

describe('range fetch arithmetic', () => {
  it('reads a cursor as the millisecond it starts at', () => {
    expect(cursorMs('1761782400123456.42')).toBe(1761782400123)
    expect(cursorMs('1761782400123999.1')).toBe(1761782400123) // µs floor to ms
    expect(cursorMs(undefined)).toBe(0)
  })

  it('ends at the window end or an earlier until', () => {
    expect(rangeEnd('2026-10-30T12:00:00Z', null)).toBe(Date.parse('2026-10-30T12:00:00Z'))
    expect(rangeEnd('2026-10-30T12:00:00Z', '2026-10-30T06:00:00Z')).toBe(Date.parse('2026-10-30T06:00:00Z'))
    expect(rangeEnd('2026-10-30T12:00:00Z', '2026-10-31T00:00:00Z')).toBe(Date.parse('2026-10-30T12:00:00Z'))
  })

  it('splits evenly into contiguous slices that end exactly at hi', () => {
    expect(sliceBounds(0, 100, 4)).toEqual([0, 25, 50, 75, 100])
    const b = sliceBounds(1000, 1103, 4) // uneven: steps round up, the last slice is shorter
    expect(b).toEqual([1000, 1026, 1052, 1078, 1103])
    for (let k = 1; k < b.length; k++) expect(b[k]).toBeGreaterThan(b[k - 1])
  })

  it('leaves trailing slices empty for very short ranges', () => {
    expect(sliceBounds(10, 12, 4)).toEqual([10, 11, 12, 12, 12])
    expect(sliceBounds(10, 10, 4)).toEqual([10, 10, 10, 10, 10])
  })
})
