// The live stream hook: heartbeats and reconnects schedule syncs, rows go to
// the worker, and a retention notice only has the retention figures read again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { LiveHandlers } from '../src/api/client'

const subs: { params: URLSearchParams; h: LiveHandlers; closed: boolean }[] = []
vi.mock('../src/api/client', async (orig) => ({
  ...(await orig<typeof import('../src/api/client')>()),
  subscribeLive: (params: URLSearchParams, h: LiveHandlers) => {
    const s = { params, h, closed: false }
    subs.push(s)
    return () => void (s.closed = true)
  },
}))
const sent: unknown[][] = []
vi.mock('../src/derive/client', async (orig) => ({
  ...(await orig<typeof import('../src/derive/client')>()),
  sendLiveRows: (rows: unknown[]) => void sent.push(rows),
}))

const { useLiveStream } = await import('../src/state/live')
const { useLiveEpoch } = await import('../src/state/data')
const { useStore } = await import('../src/state/store')

function setup() {
  const qc = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  const hook = renderHook(() => useLiveStream({ current: new Map() }), { wrapper })
  return { qc, hook }
}

beforeEach(() => {
  subs.length = 0
  sent.length = 0
  useStore.setState({ limitsReady: true, win: { live: true, durationH: 24, start: null, end: null } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the live stream', () => {
  it('subscribes for a rolling window only, and closes when the window becomes fixed', () => {
    setup()
    expect(subs.length).toBe(1)
    expect(subs[0].params.get('duration')).toBe('24h')
    act(() => useStore.setState({ win: { live: false, durationH: 24, start: '2026-11-01T00:00:00Z', end: '2026-11-02T00:00:00Z' } }))
    expect(subs[0].closed).toBe(true)
    expect(subs.length).toBe(1)
  })

  it('syncs after a reconnect and a lagged notice, and on a heartbeat at most once a minute', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { hook } = setup()
    const { h } = subs[0]
    const epoch = () => useLiveEpoch.getState().epoch
    const before = epoch()
    act(() => h.onHeartbeat({ now: new Date().toISOString(), window: { start: 'a', end: 'e1', rolling: true } }))
    expect(epoch()).toBe(before) // the views were just loaded
    vi.setSystemTime(Date.now() + 61_000)
    act(() => h.onHeartbeat({ now: new Date().toISOString(), window: { start: 'a', end: 'e2', rolling: true } }))
    expect(epoch()).toBe('e2')
    act(() => h.onStatus(false, 'reconnecting'))
    expect(hook.result.current).toBe(false)
    act(() => h.onStatus(true))
    expect(hook.result.current).toBe(true)
    expect(epoch()).toMatch(/^reconnect:/)
    const after = epoch()
    vi.setSystemTime(Date.now() + 1)
    act(() => h.onStatus(true)) // still up: nothing missed
    expect(epoch()).toBe(after)
    act(() => h.onStatus(true, 'lagged'))
    expect(epoch()).not.toBe(after)
  })

  it('hands every streamed row to the worker', () => {
    setup()
    const row = { i: 1, t: Date.now(), y: 'text', b: 'b1', c: 'LongFast' }
    act(() => subs[0].h.onDelta([{ id: 1, t: row.t, row } as never, { id: 2, t: row.t } as never]))
    expect(sent).toEqual([[row]])
  })

  it('reads only the retention figures again on a retention notice', () => {
    const { qc } = setup()
    qc.setQueryData(['retention'], { cutoff: 'x' })
    qc.setQueryData(['snapshot', 'duration=24h', 'live', '#0'], { nodes: [] })
    act(() => subs[0].h.onRetention())
    expect(qc.getQueryState(['retention'])?.isInvalidated).toBe(true)
    expect(qc.getQueryState(['snapshot', 'duration=24h', 'live', '#0'])?.isInvalidated).toBe(false)
  })
})
