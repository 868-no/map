import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dayUrl, GenerationMoved, RangeFetcher, type Stager } from '../src/derive/range'
import type { RowCache, Span } from '../src/derive/cache'

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

/** The read-through cache in memory: days by date, and one stretch of pages. */
class MemCache implements RowCache {
  generation: string | null = null
  days = new Map<number, string>()
  stretch: Span | null = null
  texts: string[] = []
  cleared = 0
  has(d: number) {
    return this.days.has(d)
  }
  async day(d: number) {
    return this.days.get(d) ?? null
  }
  putDay(d: number, text: string, generation: string) {
    if (generation !== this.generation) this.wipe(generation)
    this.days.set(d, text)
  }
  recent() {
    return this.stretch && { ...this.stretch }
  }
  async recentTexts() {
    return this.texts
  }
  putRecent(lo: number, hi: number, texts: string[], generation: string) {
    if (generation !== this.generation) this.wipe(generation)
    this.stretch = this.stretch && lo <= this.stretch.hi ? { lo: this.stretch.lo, hi: Math.max(hi, this.stretch.hi) } : { lo, hi }
    this.texts.push(...texts)
  }
  clear() {
    this.cleared++
    this.wipe(null)
  }
  private wipe(generation: string | null) {
    this.generation = generation
    this.days.clear()
    this.stretch = null
    this.texts = []
  }
}

describe('range fetch through the cache (D-184)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())
  const today = Date.parse('2026-11-02T00:00:00Z')

  it('stores the days it fetched and the paged part, then takes them from the cache', async () => {
    const s = server(() => 'g1')
    const eng = new FakeEngine()
    const f = new RangeFetcher(() => eng, s.get)
    const cache = new MemCache()
    f.cache = cache
    await f.fetchRange(params())
    expect([...cache.days.keys()].sort()).toEqual([D1, D2])
    expect(cache.stretch).toEqual({ lo: today, hi: NOW })
    // Later the same window: no day is fetched, and the paged part starts near the stretch's end.
    vi.setSystemTime(NOW + 30 * 60_000)
    s.log.length = 0
    const r = await f.fetchRange(params())
    expect(s.log).toEqual([`/api/v1/observations?duration=60h&since=${encodeURIComponent(new Date(NOW - 2 * 60_000).toISOString())}`])
    expect(eng.staged.get(r.batch)).toEqual(expect.arrayContaining(['day 2026-10-31', 'day 2026-11-01', `page ${new Date(today).toISOString()}`]))
  })

  it('serves a range the cache holds whole without a request, once the server named its generation', async () => {
    const s = server(() => 'g1')
    const eng = new FakeEngine()
    const f = new RangeFetcher(() => eng, s.get)
    f.cache = new MemCache()
    await f.fetchRange(params())
    s.log.length = 0
    const past = new URLSearchParams({ start: new Date(D1).toISOString(), end: new Date(D2 + 6 * 3_600_000).toISOString() })
    const r = await f.fetchRange(past)
    expect(s.log).toEqual([])
    expect(eng.staged.get(r.batch)).toEqual(['day 2026-10-31', 'day 2026-11-01'])
    expect(r.generation).toBe('g1')
    // Without the server's word on the generation, it asks (the answer names it).
    f.hint = null
    await f.fetchRange(past)
    expect(s.log.length).toBe(1)
  })

  it('a cache of another generation is emptied and fetched around', async () => {
    const s = server(() => 'g2')
    const eng = new FakeEngine()
    const f = new RangeFetcher(() => eng, s.get)
    const cache = new MemCache()
    cache.putDay(D1, JSON.stringify({ tag: 'old day', generation: 'g1', more: false, window: { start: '', end: '', rolling: false } }), 'g1')
    cache.cleared = 0
    f.cache = cache
    // No hint: the cached day is staged, found to be of another generation, and the range fetched again without the cache.
    const r = await f.fetchRange(params())
    expect(r.generation).toBe('g2')
    expect(eng.staged.get(r.batch)).not.toContain('old day')
    expect(cache.generation).toBe('g2')
    expect([...cache.days.keys()].sort()).toEqual([D1, D2])
    // A hint that differs (it may be the older of the two) only keeps the cache from being read.
    f.hint = 'g1'
    const before = cache.cleared
    s.log.length = 0
    await f.fetchRange(params())
    expect(cache.cleared).toBe(before)
    expect(s.log.some((u) => u.includes('/day/'))).toBe(true)
  })

  it('stores only days the server sent as final', async () => {
    const s = server(() => 'g1')
    const eng = new FakeEngine()
    // The first day comes no-store: not settled on the server yet (rows awaiting a new decoding).
    const get = async (url: string) => {
      const text = await s.get(url)
      return { text, final: !url.includes(new Date(D1).toISOString().slice(0, 10)) }
    }
    const f = new RangeFetcher(() => eng, get)
    const cache = new MemCache()
    f.cache = cache
    await f.fetchRange(params())
    expect([...cache.days.keys()]).toEqual([D2])
  })

  it('keeps the days it got when the range fails later, and asks only for the rest next time', async () => {
    const s = server(() => 'g1')
    const eng = new FakeEngine()
    let failDay2 = true
    // A poor link: the second day never arrives.
    const get = async (url: string) => {
      if (failDay2 && url.includes('/day/2026-11-01')) throw new Error('observations: network error')
      return s.get(url)
    }
    const f = new RangeFetcher(() => eng, get)
    const cache = new MemCache()
    f.cache = cache
    await expect(f.fetchRange(params())).rejects.toThrow('network error')
    expect([...cache.days.keys()]).toEqual([D1])
    expect(cache.stretch).toBeNull() // the paged part is stored only once the whole range came
    failDay2 = false
    s.log.length = 0
    await f.fetchRange(params())
    expect(s.log.filter((u) => u.includes('/day/'))).toEqual([dayUrl(D2, 'g1')])
  })

  it('offline, builds a range from the cache alone, as far as it reaches from the start', async () => {
    const s = server(() => 'g1')
    const eng = new FakeEngine()
    const f = new RangeFetcher(() => eng, s.get)
    const cache = new MemCache()
    f.cache = cache
    await f.fetchRange(params())
    const r = (await f.fetchCached(params(), NOW))!
    expect(r.covered).toEqual({ lo: D1, hi: NOW })
    expect(eng.staged.get(r.batch)?.length).toBe(3) // two days and the stretch
    cache.days.delete(D2) // a gap: the stretch no longer continues the days
    const r2 = (await f.fetchCached(params(), NOW))!
    expect(r2.covered).toEqual({ lo: D1, hi: D2 })
    expect(await new RangeFetcher(() => eng, s.get).fetchCached(params(), NOW)).toBeNull() // no cache
  })
})
