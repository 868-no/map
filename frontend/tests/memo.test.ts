import { describe, expect, it } from 'vitest'
import { ViewMemo } from '../src/derive/memo'

const bytes = (n: number) => new Uint8Array(n)

describe('view memo', () => {
  it('forgets one kind even when filter names hold the key separator', () => {
    const m = new ViewMemo(1000)
    // A channel named by a stranger, shaped to look like another kind's key.
    const fj = JSON.stringify({ channels: ['x|health'], brokers: [], types: [] })
    const healthKey = `r1|0|1|${fj}|health|`
    const snapKey = `r1|0|1|${fj}|snapshot|`
    m.remember(healthKey, 'r1', 'health', () => bytes(1))
    const snap = m.remember(snapKey, 'r1', 'snapshot', () => bytes(1))
    m.forget('health')
    expect(m.size).toBe(1)
    let rebuilt = false
    m.remember(healthKey, 'r1', 'health', () => ((rebuilt = true), bytes(1)))
    expect(rebuilt).toBe(true)
    expect(m.remember(snapKey, 'r1', 'snapshot', () => bytes(1))).toBe(snap) // kept
  })

  it('drops other revisions and keeps the total under its cap', () => {
    const m = new ViewMemo(10)
    m.remember('a', 'r1', 'snapshot', () => bytes(4))
    m.remember('b', 'r2', 'snapshot', () => bytes(4))
    expect(m.size).toBe(1) // r1 went
    m.remember('c', 'r2', 'health', () => bytes(8))
    expect(m.size).toBe(1) // over the cap: b went
  })
})
