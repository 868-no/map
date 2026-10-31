import { describe, expect, it } from 'vitest'
import { fromLocalInput, isAmbiguousLocal, toLocalInput, zoneLabel } from '../src/lib/time'

const OSLO = 'Europe/Oslo'

describe('local time handling across DST (Europe/Oslo)', () => {
  it('round-trips a normal winter time', () => {
    const utc = fromLocalInput('2026-01-15T12:00', OSLO)
    expect(utc).toBe('2026-01-15T11:00:00Z')
    expect(toLocalInput(utc!, OSLO)).toBe('2026-01-15T12:00')
  })
  it('uses UTC+2 in summer', () => {
    expect(fromLocalInput('2026-07-01T12:00', OSLO)).toBe('2026-07-01T10:00:00Z')
  })
  it('flags the repeated hour on the fall-back night', () => {
    // 2026-10-25 03:00 CEST -> 02:00 CET: 02:30 happens twice
    expect(isAmbiguousLocal('2026-10-25T02:30', OSLO)).toBe(true)
    expect(isAmbiguousLocal('2026-10-25T04:30', OSLO)).toBe(false)
  })
  it('shifts a nonexistent spring-forward time forward rather than failing', () => {
    // 2026-03-29 02:30 does not exist in Oslo
    const utc = fromLocalInput('2026-03-29T02:30', OSLO)
    expect(utc).not.toBeNull()
    expect(Date.parse(utc!)).toBeGreaterThanOrEqual(Date.parse('2026-03-29T01:00:00Z'))
  })
  it('labels the zone with the offset in effect at that instant', () => {
    expect(zoneLabel('2026-01-15T12:00:00Z', OSLO)).toContain('UTC+01:00')
    expect(zoneLabel('2026-07-15T12:00:00Z', OSLO)).toContain('UTC+02:00')
  })
})
