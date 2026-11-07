// The page side of the derivation worker (derive/client.ts), against a fake
// Worker: requests and answers by id, restarts after a failure, and a stop
// that no later call undoes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response, ViewRequest } from '../src/derive/protocol'
import type { Capabilities } from '../src/api/types'

class FakeWorker {
  static all: FakeWorker[] = []
  posted: Request[] = []
  terminated = false
  onmessage: ((e: MessageEvent<Response>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  constructor() {
    FakeWorker.all.push(this)
  }
  postMessage(m: Request) {
    this.posted.push(m)
  }
  terminate() {
    this.terminated = true
  }
  answer(r: Response) {
    this.onmessage?.({ data: r } as MessageEvent<Response>)
  }
}

const caps = { geolocation: {}, live_quantum_seconds: 10 } as unknown as Capabilities
const view: Omit<ViewRequest, 'type' | 'id'> = { kind: 'snapshot', epoch: '', rev: 0, win: { live: true, durationH: 3 }, filters: { channels: [], brokers: [], types: [] } }
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
const meta = { window: { start: 'a', end: 'b', rolling: true }, data_until: 'b' }

let client: typeof import('../src/derive/client')
beforeEach(async () => {
  FakeWorker.all = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.resetModules()
  client = await import('../src/derive/client')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the derivation worker client', () => {
  it('starts one worker, and answers each view by its id, with its meta', async () => {
    client.initDerive(caps)
    expect(FakeWorker.all.length).toBe(1)
    const w = FakeWorker.all[0]
    expect(w.posted[0]).toMatchObject({ type: 'init', liveQuantumMs: 10_000 })
    const a = client.deriveView(view)
    const b = client.deriveView({ ...view, kind: 'traffic' })
    const [ra, rb] = w.posted.slice(1) as (Request & { id: number })[]
    w.answer({ id: rb.id, ok: false, kind: 'not_found', message: 'no such node' })
    w.answer({ id: ra.id, ok: true, body: bytes({ nodes: [1] }), meta, offline: true })
    expect(await a).toEqual({ body: { nodes: [1], meta }, offline: true })
    await expect(b).rejects.toMatchObject({ kind: 'not_found' })
    expect(FakeWorker.all.length).toBe(1)
  })

  it('tells the worker when a view is no longer wanted', async () => {
    client.initDerive(caps)
    const ctl = new AbortController()
    const p = client.deriveView(view, ctl.signal)
    const id = (FakeWorker.all[0].posted[1] as Request & { id: number }).id
    ctl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.all[0].posted[2]).toEqual({ type: 'cancel', id })
  })

  it('restarts a failed worker with the same settings, and gives up after a few a minute', async () => {
    client.initDerive(caps)
    client.hintGeneration('g1')
    const changed = vi.fn()
    client.onDerivedChange(changed)
    const pending = client.deriveView(view)
    FakeWorker.all[0].answer({ type: 'fatal', message: 'unreachable' })
    await expect(pending).rejects.toMatchObject({ kind: 'internal' })
    expect(FakeWorker.all[0].terminated).toBe(true)
    const fresh = FakeWorker.all[1]
    expect(fresh.posted.map((m) => m.type)).toEqual(['init', 'generation'])
    expect(changed).toHaveBeenCalledTimes(1)
    for (let k = 1; k <= 3; k++) FakeWorker.all[k].answer({ type: 'fatal', message: 'unreachable' })
    expect(FakeWorker.all.length).toBe(4) // the fourth failure in a minute: no fifth worker
    await expect(client.deriveView(view)).rejects.toMatchObject({ kind: 'internal' })
  })

  it('stays stopped: nothing after stopDerive starts a worker again', async () => {
    client.initDerive(caps)
    const pending = client.deriveView(view)
    client.stopDerive()
    await expect(pending).rejects.toMatchObject({ kind: 'unavailable' })
    expect(FakeWorker.all[0].terminated).toBe(true)
    client.sendLiveRows([{ i: 1 } as never], [])
    client.hintGeneration('g2')
    client.sendTerrain([])
    client.setMaxNodes(500)
    client.initDerive(caps)
    await expect(client.deriveView(view)).rejects.toMatchObject({ kind: 'unavailable' })
    expect(FakeWorker.all.length).toBe(1)
  })
})
