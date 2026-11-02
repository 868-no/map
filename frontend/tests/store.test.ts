import { describe, expect, it } from 'vitest'
import { apiParams, defaultFilters, fromQuery, toQuery, useStore } from '../src/state/store'

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
  it('starts with roads and city names, other basemap names hidden', async () => {
    const { defaultToggles } = await import('../src/state/store')
    expect(defaultToggles.basemap.places).toBe(true)
    expect(defaultToggles.basemap.localPlaces).toBe(false)
    expect(defaultToggles.basemap.peaks).toBe(false)
    expect(defaultToggles.basemap.roadNames).toBe(false)
    expect(defaultToggles.basemap.borders).toBe(true)
    expect(defaultToggles.basemap.majorRoads).toBe(true)
    expect(defaultToggles.basemap.minorRoads).toBe(true)
    expect(defaultToggles.labels).toBe(true)
  })
})

describe('server window limits', () => {
  it('take the server default for a live window and clamp to its maximum', () => {
    useStore.setState({ win: { live: true, durationH: 72, start: null, end: null }, limitsReady: false })
    useStore.getState().applyLimits(24, 48)
    expect(useStore.getState().limitsReady).toBe(true)
    expect(useStore.getState().win.durationH).toBe(24)
    expect(toQuery({ win: useStore.getState().win, filters: defaultFilters }).get('duration')).toBeNull()
    useStore.setState({ win: { live: false, durationH: 24, start: '2026-10-01T00:00:00.000Z', end: '2026-10-05T00:00:00.000Z' } })
    useStore.getState().applyLimits(24, 48)
    expect(useStore.getState().win.start).toBe('2026-10-03T00:00:00.000Z') // keeps the end
    useStore.getState().applyLimits(72, 168) // restore for other tests
  })
})
