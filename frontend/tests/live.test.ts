import { describe, expect, it } from 'vitest'
import type { ObsRow } from '../src/api/types'
import { receptionFromRow } from '../src/derive/live'

const base: ObsRow = { i: 1, t: 0, b: 'x', s: 0x0a00000a, g: 0x0c00000c, y: 'position', l: 'lp1', o: 'o1', sg: 'unsigned' }

describe('receptionFromRow', () => {
  it('carries what the ping attribution reads', () => {
    expect(receptionFromRow({ ...base, hs: 5, hl: 3, r: 0x42, sn: 6.5, rs: -100 })).toEqual({
      node: '!0a00000a', gw: '!0c00000c', lp: 'lp1', direct_rf: undefined, relay: 0x42, hops: 2, path: null, snr: 6.5, rssi: -100,
    })
  })
  it('gives traceroutes their path: route for requests, route_back for replies, "" for unknown hops', () => {
    const tr = { valid: true, is_reply: false, route: [{ id: 1 }, { id: 0xffffffff, unknown: true }], route_back: [{ id: 2 }], snr_towards: [], snr_back: [] }
    expect(receptionFromRow({ ...base, y: 'traceroute', tr }).path).toEqual(['!00000001', ''])
    expect(receptionFromRow({ ...base, y: 'traceroute', tr: { ...tr, is_reply: true } }).path).toEqual(['!00000002'])
    expect(receptionFromRow({ ...base, y: 'traceroute', tr: { ...tr, valid: false } }).path).toBeNull()
  })
})
