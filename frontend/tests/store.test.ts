import { describe, expect, it } from 'vitest'
import { apiParams, defaultFilters, fromQuery, toQuery } from '../src/state/store'

describe('URL and API parameters', () => {
  const fixed = { win: { live: false, durationH: 72, start: '2026-10-28T00:00:00Z', end: '2026-10-31T00:00:00Z' },
    filters: { ...defaultFilters, channels: ['NarrowFast'] } }
  it('round-trips a fixed window and filters', () => {
    const back = fromQuery(toQuery(fixed))
    expect(back.win).toMatchObject({ live: false, start: fixed.win.start, end: fixed.win.end })
    expect(back.filters?.channels).toEqual(['NarrowFast'])
  })
  it('sends explicit bounds for fixed windows and only a duration for live', () => {
    const p = apiParams(fixed)
    expect(p.get('start')).toBe(fixed.win.start)
    const live = apiParams({ ...fixed, win: { live: true, durationH: 24, start: null, end: null } })
    expect(live.get('start')).toBeNull()
    expect(live.get('duration')).toBe('24h')
  })
  it('ignores malformed URL parameters', () => {
    expect(fromQuery(new URLSearchParams('start=yesterday&end=today')).win).toBeUndefined()
    expect(fromQuery(new URLSearchParams('duration=900h')).win).toBeUndefined()
  })
  it('starts with basemap names hidden and calm defaults', async () => {
    const { defaultToggles } = await import('../src/state/store')
    expect(defaultToggles.basemap.places).toBe(false)
    expect(defaultToggles.basemap.peaks).toBe(false)
    expect(defaultToggles.basemap.roadNames).toBe(false)
    expect(defaultToggles.basemap.borders).toBe(true)
    expect(defaultToggles.basemap.majorRoads).toBe(false)
    expect(defaultToggles.labels).toBe(true)
  })
})
