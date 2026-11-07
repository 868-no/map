// The API client: JSON requests with typed errors, the service worker's
// offline flag, and the live stream with its heartbeat watchdog.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, getJSON, getJSONFresh, postJSON, subscribeLive, type LiveHandlers } from '../src/api/client'

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', ...init.headers }, status: init.status })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('JSON requests', () => {
  it('adds the parameters when there are any, and hands the signal on', async () => {
    const fetch = vi.fn(async () => json({ ok: 1 }))
    vi.stubGlobal('fetch', fetch)
    const ctl = new AbortController()
    expect(await getJSON('/api/v1/x', new URLSearchParams({ a: '1' }), ctl.signal)).toEqual({ ok: 1 })
    await getJSON('/api/v1/y', new URLSearchParams())
    expect(fetch.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['/api/v1/x?a=1', '/api/v1/y'])
    expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: ctl.signal })
  })

  it("fails with the status and the problem's detail, or the status text", async () => {
    vi.stubGlobal('fetch', async () => json({ title: 'Bad Request', detail: 'start after end' }, { status: 400 }))
    const err = await getJSON('/api/v1/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 400, message: 'start after end' })
    vi.stubGlobal('fetch', async () => new Response('<html>', { status: 502, statusText: 'Bad Gateway' }))
    await expect(postJSON('/api/v1/terrain', {})).rejects.toMatchObject({ status: 502, message: 'Bad Gateway' })
  })

  it("tells an answer from the service worker's saved copy", async () => {
    vi.stubGlobal('fetch', async () => json({ n: 1 }, { headers: { 'x-meshmap-offline': '1' } }))
    expect(await getJSONFresh('/api/v1/retention')).toEqual({ body: { n: 1 }, offline: true })
    vi.stubGlobal('fetch', async () => json({ n: 2 }))
    expect(await getJSONFresh('/api/v1/retention')).toEqual({ body: { n: 2 }, offline: false })
  })
})

class FakeEventSource {
  static all: FakeEventSource[] = []
  listeners = new Map<string, ((e: MessageEvent) => void)[]>()
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.all.push(this)
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  close() {
    this.closed = true
  }
  emit(type: string, data: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent)
  }
}

describe('the live stream', () => {
  let h: { [K in keyof LiveHandlers]: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    FakeEventSource.all = []
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.useFakeTimers()
    h = { onDelta: vi.fn(), onHeartbeat: vi.fn(), onStatus: vi.fn(), onRetention: vi.fn() }
  })

  it('hands each event to its handler, skipping a frame that is not JSON', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stop = subscribeLive(new URLSearchParams({ duration: '24h' }), h as unknown as LiveHandlers)
    const es = FakeEventSource.all[0]
    expect(es.url).toBe('/api/v1/stream?duration=24h')
    es.emit('delta', JSON.stringify({ events: [{ id: 1 }] }))
    es.emit('delta', '{broken')
    es.emit('heartbeat', JSON.stringify({ now: 'n' }))
    es.emit('status', JSON.stringify({ live: false, reason: 'lagged' }))
    es.emit('retention', '{}')
    es.onerror?.()
    expect(h.onDelta.mock.calls).toEqual([[[{ id: 1 }]]])
    expect(h.onHeartbeat).toHaveBeenCalledWith({ now: 'n' })
    expect(h.onStatus.mock.calls).toEqual([[false, 'lagged'], [false, 'reconnecting']])
    expect(h.onRetention).toHaveBeenCalledTimes(1)
    stop()
    expect(es.closed).toBe(true)
  })

  it('reconnects when no heartbeat came for 40 s, and not while they come', () => {
    const stop = subscribeLive(new URLSearchParams(), h as unknown as LiveHandlers)
    vi.advanceTimersByTime(30_000)
    FakeEventSource.all[0].emit('heartbeat', JSON.stringify({}))
    vi.advanceTimersByTime(30_000)
    expect(FakeEventSource.all.length).toBe(1)
    vi.advanceTimersByTime(10_001)
    expect(h.onStatus).toHaveBeenCalledWith(false, 'heartbeat lost')
    expect(FakeEventSource.all.length).toBe(2)
    expect(FakeEventSource.all[0].closed).toBe(true)
    stop()
    vi.advanceTimersByTime(60_000)
    expect(FakeEventSource.all.length).toBe(2) // closed for good
  })
})
