import { beforeEach, describe, expect, it } from 'vitest'
import { noteServerTime, resetServerClock, serverNow } from '../src/lib/serverClock'

const iso = (ms: number) => new Date(ms).toISOString()
const T = Date.parse('2026-11-05T12:00:00Z')

describe('server clock', () => {
  beforeEach(() => resetServerClock())

  it('follows the first reading and any higher one at once', () => {
    noteServerTime(iso(T + 5000), T)
    expect(serverNow(T)).toBe(T + 5000)
    noteServerTime(iso(T + 17_000), T + 10_000)
    expect(serverNow(T + 10_000)).toBe(T + 17_000)
  })

  it('a thawing tab\'s backlog of stale heartbeats does not set it back', () => {
    noteServerTime(iso(T), T)
    // Frozen for 30 min; on return, 120 heartbeats are handled within a second.
    const back = T + 30 * 60_000
    for (let k = 1; k <= 120; k++) noteServerTime(iso(T + k * 15_000), back + k * 5)
    expect(serverNow(back + 600)).toBe(back + 600)
  })

  it('takes a lower reading once it persists (the local clock stepped forward)', () => {
    noteServerTime(iso(T), T)
    const jump = 60_000
    for (let s = 0; s <= 30_000; s += 15_000) noteServerTime(iso(T + 1000 + s), T + 1000 + s + jump)
    expect(serverNow(T + 31_000 + jump)).toBe(T + 31_000)
  })
})
