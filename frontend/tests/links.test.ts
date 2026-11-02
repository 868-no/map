import { describe, expect, it } from 'vitest'
import type { Edge } from '../src/derive/views'
import { linkNeighbours } from '../src/features/panels'

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
