import { describe, expect, it } from 'vitest'
import type { MeshNode, ObsRow } from '../src/api/types'
import { buildRoute } from '../src/derive/route'
import { nodeId, relayContext } from '../src/derive/graph'

const O = 0x0000aa01, R = 0x0000bb02, G1 = 0x0000cc03, G2 = 0x0000dd04, G3 = 0x0000ee05, T = 0x0000ff06
let id = 0
const row = (r: Partial<ObsRow>): ObsRow => ({ i: ++id, t: id, b: 'x', s: O, y: 'text', l: 'p', o: `o${id}`, sg: 'unsigned', ...r })
const roles = (m: Record<number, string>) => Object.entries(m).map(([n, role]) => ({ id: nodeId(+n), num: +n, identity: { role } }) as unknown as MeshNode)
const ctx = relayContext([O, R, G1, G2, G3, T], new Map(), [])
const seg = (a: number, b: number, dashed: boolean) => expect.objectContaining({ a: nodeId(a), b: nodeId(b), dashed })

describe('packet route', () => {
  it('solid for direct receptions and resolved relays, dashed across unknown nodes', () => {
    const r = buildRoute([
      row({ g: G1, dr: true, hs: 3, hl: 3 }), // heard directly
      row({ g: G2, rr: 'relayed', r: 0x02, hs: 3, hl: 2 }), // via R, which heard O directly (CLIENT spends the hop)
      row({ g: G3, rr: 'relayed', r: 0x77, hs: 3, hl: 1 }), // relay byte matches nobody
      row({ g: O, rr: 'own_packet' }), // the sender's own uplink: no segment
    ], ctx, roles({ [R]: 'CLIENT' }))!
    expect(r.segments).toEqual(expect.arrayContaining([seg(O, G1, false), seg(R, G2, false), seg(O, R, false), seg(O, G3, true)]))
    expect(r.segments).toHaveLength(4)
  })

  it('keeps the sender-to-relay hop dashed when the relay may have received at zero cost', () => {
    const r = buildRoute([row({ g: G2, rr: 'relayed', r: 0x02, hs: 3, hl: 2 })], ctx, roles({ [R]: 'ROUTER' }))!
    expect(r.segments).toEqual(expect.arrayContaining([seg(R, G2, false), seg(O, R, true)]))
  })

  it('follows a traceroute route, dashing over unrecorded hops, without doubling the gateway', () => {
    const tr = { valid: true, is_reply: false, route: [{ id: R }, { id: 0xffffffff, unknown: true }, { id: T }, { id: G1 }], route_back: [], snr_towards: [], snr_back: [] }
    const r = buildRoute([row({ y: 'traceroute', g: G1, tr })], ctx, [])!
    expect(r.segments).toEqual([seg(O, R, false), seg(R, T, true), seg(T, G1, false)])
  })

  it('prefers a solid segment over a dashed one for the same hop', () => {
    const r = buildRoute([row({ g: G3, rr: 'relayed', r: 0x77, hs: 3, hl: 2 }), row({ g: G3, dr: true, hs: 3, hl: 3 })], ctx, [])!
    expect(r.segments).toEqual([seg(O, G3, false)])
  })
})
