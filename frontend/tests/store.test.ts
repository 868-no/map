import { describe, expect, it } from 'vitest'
import { apiParams, defaultFilters, endByNow, fromQuery, toQuery, useStore } from '../src/state/store'
import { noteServerTime, serverNow } from '../src/lib/serverClock'

describe('URL and API parameters', () => {
  const fixed = { win: { live: false, durationH: 72, start: '2026-10-28T00:00:00Z', end: '2026-10-31T00:00:00Z' },
    filters: { ...defaultFilters, channels: ['NarrowFast'] } }
  it('round-trips a fixed window and filters', () => {
    const back = fromQuery(toQuery(fixed))
    expect(back.win).toMatchObject({ live: false, start: fixed.win.start, end: fixed.win.end })
    expect(back.filters?.channels).toEqual(['NarrowFast'])
  })
  it('round-trips the role filter and keeps it out of the API query (D-145)', () => {
    const withRoles = { ...fixed, filters: { ...defaultFilters, roles: ['ROUTER', 'ROUTER_LATE'] } }
    const q = toQuery(withRoles)
    expect(q.get('role')).toBe('ROUTER,ROUTER_LATE')
    expect(fromQuery(q).filters?.roles).toEqual(['ROUTER', 'ROUTER_LATE'])
    // Role is a display filter: it must not change which rows are fetched.
    expect(apiParams(withRoles).get('role')).toBeNull()
    expect(toQuery({ ...fixed, filters: defaultFilters }).get('role')).toBeNull()
  })
  it('round-trips a region page, and ignores names that are not regions (D-194)', () => {
    const q = toQuery({ ...fixed, region: 'Trøndelag' })
    expect(q.get('region')).toBe('Trøndelag')
    expect(fromQuery(q).region).toBe('Trøndelag')
    expect(fromQuery(new URLSearchParams('region=Atlantis')).region).toBeUndefined()
    expect(apiParams(fixed).get('region')).toBeNull()
  })
  it('opens the region, not the node, when a link names both (D-194)', () => {
    const both = fromQuery(new URLSearchParams('region=Vestlandet&node=!8278b930'))
    expect(both.region).toBe('Vestlandet')
    expect(both.selection).toBeUndefined()
    expect(fromQuery(new URLSearchParams('region=Atlantis&node=!8278b930')).selection).toEqual({ kind: 'node', id: '!8278b930' })
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

describe('window ends follow the server clock', () => {
  const t = (s: string) => Date.parse(s)

  it('tracks the server time from when it was received', () => {
    // The local clock runs 10 minutes ahead of the server.
    noteServerTime('2026-11-05T12:00:00Z', t('2026-11-05T12:10:00Z'))
    expect(serverNow(t('2026-11-05T12:15:00Z'))).toBe(t('2026-11-05T12:05:00Z'))
    noteServerTime('not a time') // ignored
    expect(serverNow(t('2026-11-05T12:15:00Z'))).toBe(t('2026-11-05T12:05:00Z'))
    noteServerTime(new Date().toISOString()) // back in step for other tests
  })

  it('clamps a fixed window ending in the future to end now', () => {
    const now = t('2026-11-05T12:00:00Z')
    expect(endByNow('2026-11-05T00:00:00Z', '2026-11-05T11:00:00Z', now)).toEqual(['2026-11-05T00:00:00Z', '2026-11-05T11:00:00Z'])
    expect(endByNow('2026-11-05T00:00:00Z', '2026-11-05T13:00:00Z', now)).toEqual(['2026-11-05T00:00:00.000Z', '2026-11-05T12:00:00.000Z'])
    // Wholly in the future: an hour up to now.
    expect(endByNow('2026-11-06T00:00:00Z', '2026-11-06T06:00:00Z', now)).toEqual(['2026-11-05T11:00:00.000Z', '2026-11-05T12:00:00.000Z'])
  })

  it('clamps an end from the URL', () => {
    const q = new URLSearchParams({ start: '2026-11-04T00:00:00Z', end: '2026-11-06T00:00:00Z' })
    expect(fromQuery(q, t('2026-11-05T12:00:00Z')).win).toMatchObject({ live: false, start: '2026-11-04T00:00:00.000Z', end: '2026-11-05T12:00:00.000Z' })
  })
})

describe('window changes', () => {
  it('choosing the live window already shown keeps it as it is', () => {
    useStore.getState().setLive(24)
    const win = useStore.getState().win
    useStore.getState().setLive(24)
    expect(useStore.getState().win).toBe(win) // nothing following the window restarts
    useStore.getState().setLive(48)
    expect(useStore.getState().win).toMatchObject({ live: true, durationH: 48 })
  })
})

describe('place search (D-193)', () => {
  it('drops the ringed place when the search is cleared, from anywhere', () => {
    const s = useStore.getState()
    s.setSearch('Hamar')
    s.goToPlace({ lon: 11.07, lat: 60.79, zoom: 11, name: 'Hamar' })
    s.setSearch('Hama')
    expect(useStore.getState().place?.name).toBe('Hamar')
    s.setSearch('  ')
    expect(useStore.getState().place).toBeNull()
  })
  it('keeps a region shown on the map, which is not ringed', () => {
    const s = useStore.getState()
    s.goToPlace({ lon: 10, lat: 63, zoom: 6, name: 'Trøndelag', ring: false })
    s.setSearch('')
    expect(useStore.getState().place?.name).toBe('Trøndelag')
    s.goToPlace(null)
  })
})
