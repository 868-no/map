import { describe, expect, it } from 'vitest'
import type { MeshNode } from '../src/derive/views'
import { meanPoints, weatherPoints, weatherSite } from '../src/state/weather'

const node = (role: string | undefined, extra: Partial<MeshNode> = {}): MeshNode => ({
  id: '!00000001', num: 1, status: 'observed', packets: 0, receptions: 0, gateway_receptions: 0, is_gateway: false,
  identity: role ? { role } : undefined,
  position: { lat: 63.4, lon: 10.4, precision_bits: 32, precision_known: true, source: 'position' },
  ...extra,
})

describe('weather (D-133)', () => {
  it('reads weather only at routers with a current position', () => {
    expect(weatherSite(node('ROUTER'))).toEqual({ lat: 63.4, lon: 10.4 })
    expect(weatherSite(node('ROUTER_LATE', { refined: { lat: 63.5, lon: 10.5, radius_m: 10, reports: 9, agree: 8 } }))).toEqual({ lat: 63.5, lon: 10.5 })
    expect(weatherSite(node('CLIENT'))).toBeNull()
    expect(weatherSite(node(undefined))).toBeNull()
    expect(weatherSite(node('ROUTER', { track: [{ lat: 63, lon: 10, at: '' }] }))).toEqual({ lat: 63.4, lon: 10.4 })
    expect(weatherSite(node('ROUTER', { position: undefined }))).toBeNull()
  })

  it('averages sites hour by hour over the hours any has', () => {
    const a = weatherPoints([{ t: '2026-11-01T01:00:00Z', precip_mm: 2 }, { t: '2026-11-01T02:00:00Z' }], 'precip_mm')
    const b = weatherPoints([{ t: '2026-11-01T01:00:00Z', precip_mm: 0 }, { t: '2026-11-01T02:00:00Z', precip_mm: 1 }], 'precip_mm')
    const h = (n: number) => Date.parse(`2026-11-01T0${n}:00:00Z`)
    expect(meanPoints([a, b])).toEqual([[h(1), 1], [h(2), 1]])
  })
})
