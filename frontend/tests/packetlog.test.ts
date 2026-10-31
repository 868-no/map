import { describe, expect, it } from 'vitest'
import type { ObsRow } from '../src/api/types'
import { buildPacketLog } from '../src/derive/packetlog'
import { relayContext } from '../src/derive/graph'

const X = 0x0000aa11 // the selected node (low byte 0x11)
const O = 0x0000bb22, G = 0x0000cc33, Y = 0x0000dd11 // origin, gateway, another node ending in 0x11
let id = 0
const row = (r: Partial<ObsRow>): ObsRow => ({ i: ++id, t: 1000 * id, b: 'x', s: O, y: 'text', l: `l${id}`, o: `o${id}`, sg: 'unsigned', ...r })

describe('packet logs', () => {
  it('lists own packets once per packet, with fewest hops and gateway count', () => {
    const rows = [
      row({ s: X, l: 'p1', g: G, hs: 3, hl: 1, d: 0xffffffff }),
      row({ s: X, l: 'p1', g: O, hs: 3, hl: 3, o: 'other' }),
      row({ s: X, l: 'p2', y: 'position' }),
    ]
    const log = buildPacketLog(rows, X, relayContext([X, O, G], new Map(), []))
    expect(log.own.map((p) => [p.type, p.hops, p.gateways, p.to])).toEqual([['position', undefined, 0, undefined], ['text', 0, 2, 'broadcast']])
    expect(log.relayed).toEqual([])
  })

  it('counts relays from resolved last-hop bytes and traceroute routes, never the node\'s own uplinks', () => {
    const rows = [
      row({ l: 'q1', g: G, rr: 'relayed', r: 0x11, hs: 3, hl: 2 }), // G heard X rebroadcast O's packet
      row({ l: 'q1', g: O, rr: 'relayed', r: 0x11, hs: 3, hl: 2, o: 'dup' }), // another gateway, same packet
      row({ l: 'q2', g: X, dr: true }), // X uplinking what it heard: not relaying
      row({ l: 'q3', y: 'traceroute', d: G, tr: { valid: true, is_reply: false, route: [{ id: X }], route_back: [], snr_towards: [], snr_back: [] } }),
    ]
    const log = buildPacketLog(rows, X, relayContext([X, O, G], new Map(), []))
    expect(log.relayed.map((p) => [p.type, p.evidence, p.gateways.length])).toEqual([['traceroute', ['traceroute'], 0], ['text', ['relay_byte'], 2]])
    expect(log.relayed[1].origin).toBe('!0000bb22')
  })

  it('does not count the uplinking gateway that appended itself to a traceroute route', () => {
    const tr = { valid: true, is_reply: false, route: [{ id: O + 1 }, { id: X }], route_back: [], snr_towards: [], snr_back: [] }
    expect(buildPacketLog([row({ l: 't1', y: 'traceroute', g: X, tr })], X, relayContext([X, O, G], new Map(), [])).relayed).toEqual([])
    expect(buildPacketLog([row({ l: 't2', y: 'traceroute', g: G, tr })], X, relayContext([X, O, G], new Map(), [])).relayed).toHaveLength(1)
  })

  it('ignores a last-hop byte equal to the gateway\'s own', () => {
    const G11 = 0x0000ee11 // gateway sharing X's low byte
    const rows = [row({ l: 'g1', g: G11, rr: 'relayed', r: 0x11, hs: 3, hl: 2 })]
    expect(buildPacketLog(rows, X, relayContext([X, O, G11], new Map(), [])).relayed).toEqual([])
  })

  it('does not claim an ambiguous relay byte', () => {
    const rows = [row({ l: 'z1', g: G, rr: 'relayed', r: 0x11, hs: 3, hl: 2 })]
    expect(buildPacketLog(rows, X, relayContext([X, Y, O, G], new Map(), [])).relayed).toEqual([]) // X and Y both end in 0x11
  })
})
