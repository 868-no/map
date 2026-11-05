import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dayUrl, GenerationMoved, RangeFetcher, type Stager } from '../src/derive/range'

const NOW = Date.parse('2026-11-02T12:00:00Z')
const D1 = Date.parse('2026-10-31T00:00:00Z')
const D2 = Date.parse('2026-11-01T00:00:00Z')
// A 60 h window: 2026-10-31T00:00 to now, so two whole days and today's part.
const params = () => new URLSearchParams({ duration: '60h' })

/** Fake engine: stage parses a body and hands out batch ids; bodies are kept per batch. */
class FakeEngine implements Stager {
  next = 1
  staged = new Map<number, string[]>()
  discarded: number[] = []
  stage(text: string, batch: number) {
    const b = JSON.parse(text)
    const id = batch || this.next++
    this.staged.set(id, [...(this.staged.get(id) ?? []), b.tag])
    return JSON.stringify({ ...b, batch: id })
  }
  discard(batch: number) {
    this.discarded.push(batch)
  }
}

/** A server at generation `gen`: pages and days answer with a tag; old generations get 409 (thrown as fetchText does). */
function server(gen: () => string) {
  const log: string[] = []
  const resolvers: (() => void)[] = []
  let hold = false
  const get = async (url: string) => {
    log.push(url)
    if (hold) await new Promise<void>((r) => resolvers.push(r))
    const u = new URL(url, 'http://x')
    if (u.pathname.startsWith('/api/v1/observations/day/')) {
      if (u.searchParams.get('generation') !== gen()) throw new GenerationMoved('409')
      return JSON.stringify({ tag: `day ${u.pathname.slice(-10)}`, generation: gen(), more: false, window: { start: '', end: '', rolling: false } })
    }
    return JSON.stringify({
      tag: `page ${u.searchParams.get('since') ?? ''}`,
      generation: gen(),
      more: false,
      window: { start: new Date(D1).toISOString(), end: new Date(NOW).toISOString(), rolling: true },
    })
  }
  return {
    get,
    log,
    hold: () => (hold = true),
    release: () => {
      hold = false
      for (const r of resolvers.splice(0)) r()
    },
  }
}

describe('range fetch with a generation hint (D-170)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('without a hint asks for the days only after the first page, under its generation', async () => {
    const s = server(() => 'g1')
    s.hold()
    const eng = new FakeEngine()
    const f = new RangeFetcher(() => eng, s.get)
    const done = f.fetchRange(params())
    await Promise.resolve()
    expect(s.log).toEqual([`/api/v1/observations?duration=60h&since=${encodeURIComponent('2026-11-02T00:00:00.000Z')}`])
    s.release()
    const r = await done
    expect(r.generation).toBe('g1')
    expect(s.log.slice(1).sort()).toEqual([dayUrl(D1, 'g1'), dayUrl(D2, 'g1')])
    expect(eng.staged.get(r.batch)?.slice(1).sort()).toEqual(['day 2026-10-31', 'day 2026-11-01'])
    expect(f.hint).toBe('g1') // remembered for the next range
  })

  it('with a hint asks for the days alongside the first page', async () => {
    const s = server(() => 'g1')
    s.hold()
    const eng = new FakeEngine()
    const f = new RangeFetcher(() => eng, s.get)
    f.hint = 'g1'
    const done = f.fetchRange(params())
    await Promise.resolve()
    expect(s.log.length).toBe(3) // first page and both days, before any answer
    expect(s.log.slice(1)).toEqual([dayUrl(D1, 'g1'), dayUrl(D2, 'g1')])
    s.release()
    const r = await done
    expect(s.log.length).toBe(3) // nothing asked twice
    expect(eng.staged.get(r.batch)?.length).toBe(3)
    expect(eng.discarded).toEqual([])
  })

  it('a stale hint: days are asked again under the first page generation, the 409s unused', async () => {
    const s = server(() => 'g2')
    const eng = new FakeEngine()
    const f = new RangeFetcher(() => eng, s.get)
    f.hint = 'g1'
    const r = await f.fetchRange(params())
    expect(r.generation).toBe('g2')
    expect(s.log.filter((u) => u.includes('/day/')).sort()).toEqual([dayUrl(D1, 'g1'), dayUrl(D1, 'g2'), dayUrl(D2, 'g1'), dayUrl(D2, 'g2')].sort())
    expect(s.log.filter((u) => !u.includes('/day/')).length).toBe(1) // today's part not refetched
    expect(eng.staged.get(r.batch)?.length).toBe(3)
    expect(eng.discarded).toEqual([])
    expect(f.hint).toBe('g2')
  })

  it('the generation moving after the first page: discarded and fetched again without the hint', async () => {
    let gen = 'g1'
    const s = server(() => gen)
    const eng = new FakeEngine()
    // The first page answers g1, then the server moves to g2 before the days are asked.
    const f = new RangeFetcher(() => eng, (url) => {
      const text = s.get(url)
      if (!url.includes('/day/')) gen = 'g2'
      return text
    })
    f.hint = 'g1'
    const r = await f.fetchRange(params())
    expect(eng.discarded.length).toBe(1) // the first attempt's batch
    expect(r.generation).toBe('g2')
    expect(eng.staged.get(r.batch)?.length).toBe(3)
  })

  it('prefetched days are taken by the range that plans them', async () => {
    const s = server(() => 'g1')
    const eng = new FakeEngine()
    const f = new RangeFetcher(() => eng, s.get)
    f.prefetchDays(params()) // no hint: nothing
    expect(s.log).toEqual([])
    f.hint = 'g1'
    f.prefetchDays(params())
    expect(f.pending).toEqual([dayUrl(D1, 'g1'), dayUrl(D2, 'g1')])
    const r = await f.fetchRange(params())
    expect(f.pending).toEqual([])
    expect(s.log.filter((u) => u.includes('/day/')).length).toBe(2) // each day once
    expect(eng.staged.get(r.batch)?.length).toBe(3)
  })

  it('stale prefetched days are not staged', async () => {
    const s = server(() => 'g2')
    const eng = new FakeEngine()
    const f = new RangeFetcher(() => eng, s.get)
    f.hint = 'g1'
    f.prefetchDays(params())
    await vi.waitFor(() => expect(s.log.length).toBe(2))
    const r = await f.fetchRange(params())
    expect(r.generation).toBe('g2')
    expect(eng.staged.get(r.batch)?.sort()).toEqual(['day 2026-10-31', 'day 2026-11-01', `page 2026-11-02T00:00:00.000Z`])
  })
})
