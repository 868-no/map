import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { ColResize, useColumnWidths } from '../src/components/ColumnResize'

const KEY = 'test.columns'

describe('column widths', () => {
  beforeEach(() => localStorage.clear())
  afterEach(cleanup)

  it('saves a width only when the change is final', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem')
    const { result } = renderHook(() => useColumnWidths(KEY, [80, null, 60]))
    act(() => result.current.update(0, 120.4, false))
    act(() => result.current.update(0, 130, false))
    expect(result.current.widths).toEqual([130, null, 60])
    expect(set).not.toHaveBeenCalled()
    act(() => result.current.update(0, 140, true))
    expect(set).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([140, null, null])
    set.mockRestore()
  })

  it('clamps, reads back what was saved, and forgets a reset table', () => {
    const { result, unmount } = renderHook(() => useColumnWidths(KEY, [80, null]))
    act(() => result.current.update(1, 5, true))
    expect(result.current.widths).toEqual([80, 28])
    unmount()
    const again = renderHook(() => useColumnWidths(KEY, [80, null]))
    expect(again.result.current.widths).toEqual([80, 28])
    act(() => again.result.current.update(1, null, true))
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('keeps working when storage throws', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const { result } = renderHook(() => useColumnWidths(KEY, [80]))
    act(() => result.current.update(0, 100, true))
    expect(result.current.widths).toEqual([100])
    set.mockRestore()
  })
})

describe('the resize handle', () => {
  afterEach(cleanup)

  it('says its width, measured for a shared column, with its bounds', () => {
    render(<ColResize label="From" width={null} measure={() => 143.6} onChange={() => {}} />)
    const h = screen.getByRole('separator', { name: 'From column width' })
    expect(h.getAttribute('aria-valuemin')).toBe('28')
    expect(h.getAttribute('aria-valuemax')).toBe('1200')
    fireEvent.focus(h)
    expect(h.getAttribute('aria-valuenow')).toBe('144')
  })

  it('saves with the arrow keys and Home', () => {
    const onChange = vi.fn()
    render(<ColResize label="Time" width={100} measure={() => 100} onChange={onChange} />)
    const h = screen.getByRole('separator')
    fireEvent.keyDown(h, { key: 'ArrowRight' })
    fireEvent.keyDown(h, { key: 'ArrowLeft' })
    fireEvent.keyDown(h, { key: 'Home' })
    fireEvent.keyDown(h, { key: 'a' })
    expect(onChange.mock.calls).toEqual([[110, true], [90, true], [null, true]])
  })

  it('drags without saving until the pointer is let go', () => {
    const onChange = vi.fn()
    render(<ColResize label="Time" width={100} measure={() => 100} onChange={onChange} />)
    const h = screen.getByRole('separator')
    h.setPointerCapture = () => {}
    fireEvent.pointerDown(h, { clientX: 10, pointerId: 1 })
    expect(document.body.classList.contains('resizing-col')).toBe(true)
    fireEvent.pointerMove(h, { clientX: 30, pointerId: 1 })
    fireEvent.pointerMove(h, { clientX: 40, pointerId: 1 })
    fireEvent.pointerUp(h, { clientX: 40, pointerId: 1 })
    expect(onChange.mock.calls).toEqual([[120, false], [130, false], [130, true]])
    expect(document.body.classList.contains('resizing-col')).toBe(false)
  })

  it('gives the page its text selection back when unmounted mid-drag', () => {
    const { unmount } = render(<ColResize label="Time" width={100} measure={() => 100} onChange={() => {}} />)
    const h = screen.getByRole('separator')
    h.setPointerCapture = () => {}
    fireEvent.pointerDown(h, { clientX: 10, pointerId: 1 })
    expect(document.body.classList.contains('resizing-col')).toBe(true)
    unmount()
    expect(document.body.classList.contains('resizing-col')).toBe(false)
  })
})
