import { describe, expect, it } from 'vitest'
import type { NodeView } from '../src/derive/views'
import { coverageLink, LINKSIM } from '../src/features/node/Coverage'

const ORIGIN = 'https://map.868.no'
const pos = { lat: 59.912345678, lon: 10.75, precision_bits: 32, precision_known: true, signature: 'unsigned', observed_at: '2026-11-13T10:00:00Z', source: 'position' }
const node = (extra: Record<string, unknown> = {}) =>
  ({ id: '!34000001', num: 0x34000001, identity: { long_name: 'Hill Relay' }, position: pos, ...extra }) as unknown as NodeView

describe('coverageLink (D-214)', () => {
  it('opens LinkSim at the reported position with name and attribution', () => {
    const u = new URL(coverageLink(node(), ORIGIN)!)
    expect(`${u.origin}/`).toBe(LINKSIM)
    expect(Object.fromEntries(u.searchParams)).toEqual({
      site: '1', lat: '59.91235', lon: '10.75000', name: 'Hill Relay', source: 'map.868.no', sourceUrl: 'https://map.868.no/?node=!34000001',
    })
  })
  it('prefers the refined place', () => {
    const u = new URL(coverageLink(node({ refined: { lat: 60, lon: 11, radius_m: 40 } }), ORIGIN)!)
    expect([u.searchParams.get('lat'), u.searchParams.get('lon')]).toEqual(['60.00000', '11.00000'])
  })
  it('holds a refined place to the same cutoff: narrowing never adds precision', () => {
    expect(coverageLink(node({ position: { ...pos, precision_bits: 13 }, refined: { lat: 60, lon: 11, radius_m: 1600 } }), ORIGIN)).toBeUndefined()
  })
  it('leaves out the attribution link off HTTPS, and a missing name', () => {
    const u = new URL(coverageLink(node({ identity: undefined }), 'http://localhost:5173')!)
    expect(u.searchParams.has('sourceUrl')).toBe(false)
    expect(u.searchParams.has('name')).toBe(false)
    expect(u.searchParams.get('source')).toBe('localhost')
  })
  it('is not offered without a precise enough position, or for an opt-out node', () => {
    expect(coverageLink(node({ position: undefined }), ORIGIN)).toBeUndefined()
    expect(coverageLink(node({ position: { ...pos, precision_bits: 14 } }), ORIGIN)).toBeUndefined()
    expect(coverageLink(node({ position: { ...pos, precision_known: false } }), ORIGIN)).toBeUndefined()
    expect(coverageLink(node({ position: { ...pos, precision_bits: 15 } }), ORIGIN)).toBeDefined()
    expect(coverageLink(node({ mqtt_opt_out: true }), ORIGIN)).toBeUndefined()
  })
})
