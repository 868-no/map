import { describe, expect, it } from 'vitest'
import type { Edge, Hearing } from '../src/derive/views'
import { linkNeighbours, sortHearings } from '../src/features/node/sort'

const edge = (src: string, dst: string, confidence: string, snr?: number, mqtt = false) =>
  ({ src, dst, confidence, mqtt, snr: { median: snr } }) as unknown as Edge

describe('Links in window', () => {
  it('groups both directions per neighbour and sorts by confidence, then SNR, internet last', () => {
    const names = new Map([['!b', 'Bravo'], ['!c', 'Charlie'], ['!d', 'Delta'], ['!e', 'Echo']])
    const g = linkNeighbours(
      [
        edge('!a', '!b', 'medium', 2), edge('!b', '!a', 'high', -5), // high in one direction
        edge('!c', '!a', 'high', 6), // high, stronger
        edge('!a', '!d', 'medium', 9),
        edge('!a', '!e', 'low'), edge('!e', '!a', 'low', -12, true),
        edge('!x', '!y', 'high', 10), // not this node's
      ],
      '!a',
      names,
    )
    expect(g.map((n) => `${n.peer}${n.mqtt ? ' mqtt' : ''}`)).toEqual(['!c', '!b', '!d', '!e', '!e mqtt'])
    const bravo = g.find((n) => n.peer === '!b')!
    expect([bravo.out?.confidence, bravo.in?.confidence]).toEqual(['medium', 'high'])
    expect(g.find((n) => n.peer === '!c')!.out).toBeUndefined()
  })
})

describe('Heard by gateways', () => {
  it('sorts by the radio link confidence, then SNR, relayed-only gateways last', () => {
    const hear = (node: string, snr?: number) => ({ node, receptions: 1, direct_rf: 0, snr: { median: snr }, rssi: {}, last_at: '' }) as unknown as Hearing
    const rows = sortHearings(
      [hear('!g1', 9), hear('!g2', 3), hear('!g3', 12), hear('!g4', 15), hear('!g5', 1)],
      '!a',
      [edge('!a', '!g1', 'medium', 9), edge('!a', '!g2', 'high', 3), edge('!a', '!g3', 'high', 12), edge('!g5', '!a', 'high', 1), edge('!a', '!g5', 'low', 1, true)],
      new Map(),
    )
    // !g4 has no link from !a (relayed only); !g5's links are the wrong way or over MQTT.
    expect(rows.map((r) => r.h.node)).toEqual(['!g3', '!g2', '!g1', '!g4', '!g5'])
    expect(rows[3].link).toBeUndefined()
  })
})
