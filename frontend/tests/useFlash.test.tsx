import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useFlash } from '../src/lib/useFlash'

afterEach(() => vi.useRealTimers())

describe('useFlash', () => {
  it('shows a value for a while, then the idle one; flashing again restarts the time', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useFlash<'idle' | 'copied' | 'failed'>('idle', 1000))
    act(() => result.current[1]('copied'))
    expect(result.current[0]).toBe('copied')
    act(() => vi.advanceTimersByTime(800))
    act(() => result.current[1]('failed'))
    act(() => vi.advanceTimersByTime(800))
    expect(result.current[0]).toBe('failed') // the first flash's timer did not cut the second short
    act(() => vi.advanceTimersByTime(200))
    expect(result.current[0]).toBe('idle')
  })

  it('leaves no timer behind when the component goes', () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useFlash(false))
    act(() => result.current[1](true))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
