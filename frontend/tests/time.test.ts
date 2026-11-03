import { describe, expect, it } from 'vitest'
import { formatLocal, formatLogTime, formatShort, fromLocalInput, isAmbiguousLocal, toLocalInput, zoneLabel } from '../src/lib/time'

const OSLO = 'Europe/Oslo'

describe('local time handling across DST (Europe/Oslo)', () => {
  it('round-trips a normal winter time', () => {
    const utc = fromLocalInput('2026-01-15T12:00', OSLO)
    expect(utc).toBe('2026-01-15T11:00:00Z')
    expect(toLocalInput(utc!, OSLO)).toBe('2026-01-15T12:00')
  })
  it('uses UTC+2 in summer', () => {
    expect(fromLocalInput('2026-07-01T12:00', OSLO)).toBe('2026-07-01T10:00:00Z')
    expect(toLocalInput('2026-07-01T10:00:00Z', OSLO)).toBe('2026-07-01T12:00')
  })
  it('keeps seconds and milliseconds when given', () => {
    expect(fromLocalInput('2026-01-15T12:00:30', OSLO)).toBe('2026-01-15T11:00:30Z')
    expect(fromLocalInput('2026-01-15T12:00:30.25', OSLO)).toBe('2026-01-15T11:00:30.250Z')
  })
  it('rejects values that are not a valid local time', () => {
    expect(fromLocalInput('', OSLO)).toBeNull()
    expect(fromLocalInput('2026-02-30T12:00', OSLO)).toBeNull()
    expect(fromLocalInput('2026-01-15T25:00', OSLO)).toBeNull()
    expect(fromLocalInput('2026-01-15 12:00', OSLO)).toBeNull()
    expect(isAmbiguousLocal('nonsense', OSLO)).toBe(false)
  })
  it('flags the repeated hour on the fall-back night', () => {
    // 2026-10-25 03:00 CEST -> 02:00 CET: 02:30 happens twice
    expect(isAmbiguousLocal('2026-10-25T02:30', OSLO)).toBe(true)
    expect(isAmbiguousLocal('2026-10-25T01:30', OSLO)).toBe(false)
    expect(isAmbiguousLocal('2026-10-25T03:00', OSLO)).toBe(false)
    expect(isAmbiguousLocal('2026-10-25T04:30', OSLO)).toBe(false)
  })
  it('resolves a repeated time to the earlier instant, whatever the date today', () => {
    expect(fromLocalInput('2026-10-25T02:30', OSLO)).toBe('2026-10-25T00:30:00Z') // still CEST
    expect(fromLocalInput('2026-10-25T03:00', OSLO)).toBe('2026-10-25T02:00:00Z') // CET
  })
  it('shifts a nonexistent spring-forward time forward by the jump', () => {
    // 2026-03-29 02:30 does not exist in Oslo: 01:30Z is 03:30 CEST
    expect(fromLocalInput('2026-03-29T02:30', OSLO)).toBe('2026-03-29T01:30:00Z')
    expect(isAmbiguousLocal('2026-03-29T02:30', OSLO)).toBe(false)
    expect(fromLocalInput('2026-03-29T01:59', OSLO)).toBe('2026-03-29T00:59:00Z')
    expect(fromLocalInput('2026-03-29T03:00', OSLO)).toBe('2026-03-29T01:00:00Z')
  })
  it('labels the zone with the offset in effect at that instant', () => {
    expect(zoneLabel('2026-01-15T12:00:00Z', OSLO)).toContain('UTC+01:00')
    expect(zoneLabel('2026-07-15T12:00:00Z', OSLO)).toContain('UTC+02:00')
    expect(zoneLabel('2026-07-15T12:00:00Z', OSLO)).toMatch(/^Europe\/Oslo \(.+, UTC\+02:00\)$/)
    expect(zoneLabel('2026-07-15T12:00:00Z', 'Asia/Kolkata')).toContain('UTC+05:30')
    expect(zoneLabel('2026-07-15T12:00:00Z', 'America/St_Johns')).toContain('UTC-02:30')
    expect(zoneLabel('2026-07-15T12:00:00Z', 'UTC')).toBe('UTC (UTC, UTC+00:00)')
  })
  it('formats instants in the zone across the DST change', () => {
    expect(formatLocal('2026-10-25T00:30:00Z', OSLO)).toBe('2026-10-25 02:30:00')
    expect(formatLocal('2026-10-25T01:30:00Z', OSLO)).toBe('2026-10-25 02:30:00')
    expect(formatLocal('2026-12-31T23:00:00Z', OSLO)).toBe('2027-01-01 00:00:00')
    expect(formatLocal(null, OSLO)).toBe('—')
    expect(formatShort('2026-07-01T22:05:00Z', OSLO)).toMatch(/^\S+ 02 00:05$/)
  })
  it('shows only the time of day for times on the same local day', () => {
    const now = Date.parse('2026-07-01T21:30:00Z') // 23:30 in Oslo
    expect(formatLogTime('2026-06-30T22:10:05Z', now, OSLO)).toBe('00:10:05')
    expect(formatLogTime('2026-06-30T21:59:00Z', now, OSLO)).toMatch(/^\S+ 30 23:59$/)
  })
})
