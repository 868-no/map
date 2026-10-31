import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debounce } from '../src/derive/debounce'

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
})
