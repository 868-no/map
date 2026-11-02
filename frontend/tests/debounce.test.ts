import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debounce, rebuildDelay } from '../src/derive/debounce'

describe('debounce with a ceiling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs once after calls pause', () => {
    const fn = vi.fn()
    const d = debounce(fn, 2000, 5000)
    d()
    vi.advanceTimersByTime(1500)
    d()
    vi.advanceTimersByTime(1999)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('still runs at the ceiling under a steady stream of calls', () => {
    const fn = vi.fn()
    const d = debounce(fn, 2000, 5000)
    for (let t = 0; t < 12_000; t += 500) {
      d()
      vi.advanceTimersByTime(500)
    }
    expect(fn).toHaveBeenCalledTimes(2) // at 5 s and 10 s
  })

  it('reads function timings at call time', () => {
    const fn = vi.fn()
    let h: number | null = 72
    const d = debounce(fn, () => rebuildDelay(h).quietMs, () => rebuildDelay(h).maxMs)
    d()
    vi.advanceTimersByTime(9_999)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    h = 1
    d()
    vi.advanceTimersByTime(2_000)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('rebuild delay by live window length', () => {
  it('keeps short and fixed windows quick', () => {
    expect(rebuildDelay(1)).toEqual({ quietMs: 2000, maxMs: 5000 })
    expect(rebuildDelay(6)).toEqual({ quietMs: 2000, maxMs: 5000 })
    expect(rebuildDelay(null)).toEqual({ quietMs: 2000, maxMs: 5000 })
  })
  it('slows long windows down, linearly from 6 h to 24 h', () => {
    expect(rebuildDelay(15)).toEqual({ quietMs: 6000, maxMs: 10_000 })
    expect(rebuildDelay(24)).toEqual({ quietMs: 10_000, maxMs: 15_000 })
    expect(rebuildDelay(168)).toEqual({ quietMs: 10_000, maxMs: 15_000 })
  })
})

describe('rebuild delay scales with build time', () => {
  it('waits at least 20× (quiet) and 30× (max) the last build', () => {
    expect(rebuildDelay(1, 0)).toEqual({ quietMs: 2000, maxMs: 5000 })
    expect(rebuildDelay(1, 500)).toEqual({ quietMs: 10_000, maxMs: 15_000 })
    expect(rebuildDelay(72, 50)).toEqual({ quietMs: 10_000, maxMs: 15_000 }) // the table wins for fast builds
  })
})
