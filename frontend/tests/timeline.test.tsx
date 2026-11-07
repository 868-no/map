// The period controls (D-067): the header's mode badge and the Period
// panel's presets and sliding, kept within retention and the longest window.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Capabilities, Retention } from '../src/api/types'

vi.mock('../src/state/data', () => ({ useTraffic: () => ({ data: undefined }) }))
const { LiveIndicator, PeriodPanel } = await import('../src/timeline/Timeline')
const { useStore } = await import('../src/state/store')

const H = 3_600_000
const NOW = Date.parse('2026-11-08T12:00:00Z')
const caps = { max_window_hours: 336, presets: [{ label: '24h', hours: 24 }, { label: '3d', hours: 72 }] } as unknown as Capabilities
// Retention reaches back to 10 days ago (its cutoff not on the hour).
const retention = { configured_cutoff: new Date(NOW - 10 * 24 * H - 30 * 60_000).toISOString() } as unknown as Retention
const minMs = Math.ceil(Date.parse(retention.configured_cutoff) / H) * H
const iso = (ms: number) => new Date(ms).toISOString()
const win = () => useStore.getState().win

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  useStore.setState({ win: { live: true, durationH: 72, start: null, end: null } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the mode badge', () => {
  it('says live, paused or historical, with the length', () => {
    const onOpen = vi.fn()
    const { rerender } = render(<LiveIndicator caps={caps} retention={retention} snapshot={undefined} liveOK onOpen={onOpen} />)
    expect(screen.getByRole('button', { name: /LIVE/ }).textContent).toBe('● LIVE 3d')
    fireEvent.click(screen.getByRole('button', { name: /LIVE/ }))
    expect(onOpen).toHaveBeenCalled()
    rerender(<LiveIndicator caps={caps} retention={retention} snapshot={undefined} liveOK={false} onOpen={onOpen} />)
    expect(screen.getByRole('button', { name: /LIVE/ }).textContent).toBe('○ LIVE (paused) 3d')
    expect(screen.queryByText('Return to live')).toBeNull()
  })

  it('returns a fixed window to live, at its length', () => {
    useStore.setState({ win: { live: false, durationH: 72, start: iso(NOW - 30 * H), end: iso(NOW - 18 * H) } })
    render(<LiveIndicator caps={caps} retention={retention} snapshot={undefined} liveOK onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: /HISTORICAL/ }).textContent).toBe('HISTORICAL 12h')
    fireEvent.click(screen.getByText('Return to live'))
    expect(win()).toEqual({ live: true, durationH: 12, start: null, end: null })
  })
})

describe('the Period panel', () => {
  it('a preset keeps a live window live, and a fixed one its end', () => {
    render(<PeriodPanel caps={caps} retention={retention} snapshot={undefined} />)
    fireEvent.click(screen.getByText('24h'))
    expect(win()).toMatchObject({ live: true, durationH: 24 })
    act(() => useStore.setState({ win: { live: false, durationH: 24, start: iso(NOW - 48 * H), end: iso(NOW - 40 * H) } }))
    fireEvent.click(screen.getByText('3d'))
    expect(win()).toMatchObject({ live: false, start: iso(NOW - 112 * H), end: iso(NOW - 40 * H) })
  })

  it('slides within retention and never past now', () => {
    useStore.setState({ win: { live: false, durationH: 24, start: iso(minMs + 6 * H), end: iso(minMs + 30 * H) } })
    render(<PeriodPanel caps={caps} retention={retention} snapshot={undefined} />)
    fireEvent.click(screen.getByLabelText('Move window back'))
    expect(win()).toMatchObject({ start: iso(minMs), end: iso(minMs + 18 * H) }) // the start held at the limit
    expect((screen.getByLabelText('Move window back') as HTMLButtonElement).disabled).toBe(true)
    act(() => useStore.setState({ win: { live: false, durationH: 24, start: iso(NOW - 30 * H), end: iso(NOW - 6 * H) } }))
    fireEvent.click(screen.getByLabelText('Move window forward'))
    expect(win()).toMatchObject({ start: iso(NOW - 18 * H), end: iso(NOW) })
  })
})
