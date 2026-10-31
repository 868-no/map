import { describe, expect, it } from 'vitest'
import { matchesRequest } from '../src/api/client'

const meta = (start: string, end: string, rolling: boolean) =>
  ({ window: { start, end, rolling }, revision: 'r', filters: {}, generated_at: end }) as never

describe('stale response guard (no cross-window contamination)', () => {
  const q = new URLSearchParams({ start: '2026-10-28T00:00:00Z', end: '2026-10-31T00:00:00Z' })
  it('accepts the window it asked for', () => {
    expect(matchesRequest(meta('2026-10-28T00:00:00Z', '2026-10-31T00:00:00Z', false), q)).toBe(true)
  })
  it('rejects a late response for a different window', () => {
    expect(matchesRequest(meta('2026-10-27T00:00:00Z', '2026-10-30T00:00:00Z', false), q)).toBe(false)
  })
  it('does not mix rolling and fixed results', () => {
    expect(matchesRequest(meta('2026-10-28T00:00:00Z', '2026-10-31T00:00:00Z', true), q)).toBe(false)
    expect(matchesRequest(meta('2026-10-28T00:00:00Z', '2026-10-31T00:00:00Z', true), new URLSearchParams({ duration: '72h' }))).toBe(true)
  })
})
