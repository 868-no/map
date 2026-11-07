// The worker's range fetch: every row of a window into one staged batch of
// the engine (kept apart from the worker so tests can run it without
// WebAssembly).
import { OVERLAP_MS, type Coverage, type Fetched } from './rowStore'
import type { RowCache } from './cache'
import { Abandoned, abandonable, cursorMs, DAY_MS, dayName, limiter, planDays, rangeEnd, requestedRange, settleFirst, sliceBounds } from './slices'
import { ViewError } from './views'
import { backendBusy, gatewayDown, retryDelay } from './httpStatus'

/** Parallel requests for the rest of a range after its first page. */
const SLICES = 4
/** Requests in flight at once: the server lets a client run 4 reads (API_READS_PER_CLIENT). */
const PARALLEL = 4
/** A page not answered in this long fails the range, as if offline. */
const PAGE_TIMEOUT_MS = 30_000
/** Retries of a page answered 429 or busy, each after its Retry-After (at most 10 s). */
const RATE_RETRIES = 3

/** The cache's stretch is read only when it covers more than this of a range's paged part. */
const STRETCH_MIN_MS = 10 * 60_000

/** A whole day was asked for under a generation the server no longer has (409): refetch the range. */
export class GenerationMoved extends Error {}

/** A response's text, and whether the server sent it as final (immutable: a whole day that cannot change). */
export interface Got {
  text: string
  final: boolean
}
/** What a fetch hands back: a text, final when it is a bare string (tests), or a Got. */
const got = (r: string | Got): Got => (typeof r === 'string' ? { text: r, final: true } : r)

/** GETs an API URL as text, retrying while the backend is busy; errors are typed as fetchRange's callers expect. */
async function fetchText(url: string): Promise<Got> {
  let res: globalThis.Response
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) })
    } catch (e) {
      throw new Error(`observations: ${e instanceof Error ? e.message : e}`, { cause: e })
    }
    // Rate-limited (several tabs or a shared address) or busy: wait and try again.
    if (!backendBusy(res) || attempt >= RATE_RETRIES) break
    await new Promise((r) => setTimeout(r, retryDelay(res, attempt)))
  }
  // Still busy after the retries falls through to an 'upstream' error below:
  // the backend is up, so this is no reason to show the saved copy.
  if (gatewayDown(res)) throw new Error(`observations: ${res.status}`)
  if (res.status === 409) throw new GenerationMoved('observations: the server changed generation')
  if (!res.ok) {
    let detail = res.statusText
    try {
      const b = await res.json()
      detail = b.detail ?? b.title ?? detail
    } catch {
      /* non-JSON error body */
    }
    throw new ViewError('upstream', `observations: ${res.status} ${detail}`)
  }
  try {
    return { text: await res.text(), final: /\bimmutable\b/.test(res.headers.get('Cache-Control') ?? '') }
  } catch (e) {
    throw new Error(`observations: ${e instanceof Error ? e.message : e}`, { cause: e }) // timed out or cut off mid-body
  }
}

/** The engine's staging area: stage returns the page's meta as JSON (with its batch id). */
export interface Stager {
  stage(text: string, batch: number): string
  discard(batch: number): void
}

/** The URL of a whole UTC day's rows under a generation (D-158). */
export const dayUrl = (d: number, generation: string) => `/api/v1/observations/day/${dayName(d)}?generation=${encodeURIComponent(generation)}`

type Meta = { window: Fetched<number>['window']; generation: string; more: boolean; next_cursor?: string; batch: number }

export class RangeFetcher {
  /**
   * The generation the server last reported (/retention, or a range's first
   * page). Days are asked under it at once, before the first page tells the
   * generation; a stale one is caught and the days asked again (D-170).
   */
  hint: string | null = null
  private prefetched = new Map<string, Promise<Got>>()
  private slots = limiter(PARALLEL)

  /** The read-through cache (D-184): set once it is open, absent without storage. */
  cache: RowCache | null = null

  constructor(private engine: () => Stager, private get: (url: string) => Promise<string | Got> = fetchText) {}

  /**
   * Starts fetching the whole days of a range under the hint, before the
   * engine is ready; fetchRange takes the texts when it plans the same days.
   * Without a hint nothing is fetched.
   */
  prefetchDays(params: URLSearchParams, now = Date.now()) {
    if (!this.hint) return
    const { lo, hi } = requestedRange(params, now)
    for (const d of planDays(lo, hi, now)) {
      const url = dayUrl(d, this.hint)
      if (this.prefetched.has(url) || (this.cache?.generation === this.hint && this.cache.has(d))) continue
      const p = this.slots(() => this.get(url)).then(got)
      p.catch(() => {}) // a failure is the range's when it is taken
      this.prefetched.set(url, p)
    }
  }

  /** Forgets prefetched days not taken (they were not needed). */
  dropPrefetched() {
    this.prefetched.clear()
  }

  /** URLs prefetched and not yet taken (tests). */
  get pending(): string[] {
    return [...this.prefetched.keys()]
  }

  /**
   * Fetches every row of a range into one staged batch. Whole past UTC days
   * come from /observations/day, which every visitor shares (HTTP caches,
   * Cloudflare, the server's Redis; D-158); the rest from /observations. The
   * first request (the part after the last whole day, or the whole range)
   * tells the window, the generation and where its rest begins; that rest is
   * split into time slices fetched in parallel with the days and the part
   * before them (each paged, all into the same batch; the engine drops
   * duplicates on commit). With a generation hint the days are asked for
   * alongside the first request (D-170); their texts are staged once it
   * answered, and only when it names the same generation, else they are
   * asked again under its generation. A whole first day may hold rows from
   * before the window: views are built from the window only.
   */
  fetchRange = async (params: URLSearchParams, retry = true): Promise<Fetched<number>> => {
    const engine = this.engine()
    // After a generation moved: straight from the server (the cache starts over).
    const cache = retry ? this.cache : null
    const cached = !!cache?.generation && (!this.hint || this.hint === cache.generation)
    // A failed request fails the range: the others stop before their next
    // request (even one still waiting for a slot) or at their next page, and the
    // batch is discarded, so no staged rows are stranded in the engine.
    let failed = false
    const run = abandonable(this.slots, () => failed)
    const page = (extra: Record<string, string>, keep?: string[]) => {
      const p = new URLSearchParams(params)
      for (const [k, v] of Object.entries(extra)) p.set(k, v)
      const text = run(() => this.get(`/api/v1/observations?${p}`)).then((r) => got(r).text)
      if (keep) void text.then((t) => keep.push(t), () => {})
      return text
    }
    // A day's text: cached, prefetched (asked again if that failed), or fetched
    // now; store says whether it goes into the cache once staged. Only a day the
    // server sent as final: one still settling (rows awaiting a new decoding,
    // the writer behind, an import running) comes no-store and may change.
    const day = async (d: number, generation: string): Promise<{ text: string; store: boolean }> => {
      if (cached) {
        const text = await cache!.day(d)
        if (text !== null) return { text, store: false }
      }
      const url = dayUrl(d, generation)
      const pre = this.prefetched.get(url)
      this.prefetched.delete(url)
      const r = got(await (pre ? pre.catch(() => run(() => this.get(url))) : run(() => this.get(url))))
      return { text: r.text, store: r.final }
    }
    const iso = (ms: number) => new Date(ms).toISOString()
    const now = Date.now()
    const { lo, hi } = requestedRange(params, now)
    const days = planDays(lo, hi, now)
    // The paged part follows the last whole day. When the cache's newest
    // stretch covers its start (D-184), only rows after the stretch are asked
    // for, with an overlap for rows committed late.
    const tailLo = days.length ? days[days.length - 1] + DAY_MS : lo
    const stretch = cached ? cache!.recent() : null
    // Only when it saves real paging: a rolling window's minute syncs ask from just before the stretch's end anyway.
    const fromStretch = !!stretch && tailLo < hi && stretch.lo <= tailLo && stretch.hi - tailLo > STRETCH_MIN_MS
    const stretchTexts = fromStretch ? cache!.recentTexts() : null
    const tailSince = fromStretch ? Math.max(tailLo, stretch!.hi - OVERLAP_MS) : tailLo
    // All of it cached, under the generation the server last reported: no request at all.
    if (cached && this.hint === cache!.generation && tailSince >= hi && days.every((d) => cache!.has(d))) {
      const texts = [...(await Promise.all(days.map((d) => cache!.day(d)))), ...((await stretchTexts) ?? [])]
      if (texts.length && texts.every((t) => t !== null)) {
        const batch = (JSON.parse(engine.stage(texts[0]!, 0)) as Meta).batch
        for (const t of texts.slice(1)) engine.stage(t!, batch)
        const window = { start: params.get('start') ?? iso(lo), end: params.get('end') ?? iso(hi), rolling: !params.has('start') }
        return { window, generation: cache!.generation!, batch }
      }
    }
    // With whole days or the stretch, the first request is the part after them (empty when the range ends there).
    const tail: Record<string, string> = days.length || fromStretch ? { since: iso(tailSince) } : {}
    const tailTexts: string[] = [] // the paged part's pages, for the cache's stretch
    const firstText = page(tail, tailTexts)
    // Not after a 409: the hint is then known to be stale.
    const hint = retry ? this.hint : null
    const early = new Map(hint ? days.map((d) => [d, day(d, hint)]) : [])
    for (const p of early.values()) p.catch(() => {}) // unused when the hint is stale
    let first: Meta
    try {
      first = JSON.parse(engine.stage(await firstText, 0)) as Meta
    } catch (e) {
      failed = true
      throw e
    }
    this.hint = first.generation
    const batch = first.batch
    const stage = (text: string) => {
      if (failed) throw new Abandoned('observations: range abandoned')
      return JSON.parse(engine.stage(text, batch)) as Meta
    }
    // A day or a cached page of another generation restarts the range without the cache.
    const stageOwn = (text: string) => {
      if (stage(text).generation !== first.generation) throw new GenerationMoved('observations: rows of another generation')
    }
    const drain = async (meta: Meta, extra: Record<string, string>, keep?: string[]) => {
      while (meta.more) meta = stage(await page({ ...extra, cursor: meta.next_cursor ?? '' }, keep))
    }
    const tasks: (() => Promise<unknown>)[] = []
    if (first.more) {
      // The rest starts at the first page's cursor instant.
      const bounds = sliceBounds(cursorMs(first.next_cursor), rangeEnd(first.window.end, params.get('until')), SLICES)
      bounds.slice(0, -1).forEach((b, k) =>
        tasks.push(async () => {
          const range = { ...tail, until: iso(bounds[k + 1]) }
          if (k === 0) return drain(first, range, tailTexts) // continues after the first page
          if (b >= bounds[k + 1]) return
          const since = { ...range, since: iso(b) }
          return drain(stage(await page(since, tailTexts)), since, tailTexts)
        }),
      )
    }
    if (stretchTexts) tasks.push(async () => (await stretchTexts).forEach(stageOwn))
    if (days.length) {
      // Before the first whole day: from the window's start as the server set it.
      const start = Math.max(Date.parse(first.window.start), params.has('since') ? Date.parse(params.get('since')!) : -Infinity)
      if (start < days[0]) {
        const head = { until: iso(days[0]) }
        tasks.push(async () => drain(stage(await page(head)), head))
      }
      // Days asked under a stale hint are dropped (the server answers them 409).
      const asked = hint === first.generation ? early : new Map<number, ReturnType<typeof day>>()
      for (const d of days)
        tasks.push(async () => {
          const r = await (asked.get(d) ?? day(d, first.generation))
          // Into the cache as soon as it arrived, even when another part of the
          // range has failed meanwhile (a poor link, a 14-day window): the next
          // attempt asks only for the rest. It was asked under this generation,
          // which a day's URL names (another is answered 409).
          if (r.store) this.cache?.putDay(d, r.text, first.generation)
          stageOwn(r.text)
        })
    }
    // The range fails with the first failure in time (a 409 to retry under the
    // new generation, a gateway's 502 that sends the page to the saved copy),
    // never with another task's abandonment.
    const err = await settleFirst(tasks, () => (failed = true))
    if (err) {
      engine.discard(batch)
      if (err.reason instanceof GenerationMoved) {
        // Decoder, configuration or history changed between our requests:
        // start over once, under the new generation (the store then sees it).
        if (retry) {
          this.cache?.clear()
          return this.fetchRange(params, false)
        }
        throw new ViewError('upstream', err.reason.message)
      }
      throw err.reason
    }
    // Into the cache: a rolling window's paged part, which holds every row of its range (only once all of it came).
    if (this.cache && first.window.rolling) {
      const since = tail.since ?? params.get('since')
      const from = Math.max(Date.parse(first.window.start), since ? Date.parse(since) : -Infinity)
      this.cache.putRecent(from, rangeEnd(first.window.end, params.get('until')), tailTexts, first.generation, now)
    }
    return { window: first.window, generation: first.generation, batch }
  }

  /**
   * Offline, with nothing held: what the cache has of a range, staged as one
   * batch: its stored days from the range's start while they follow one
   * another, then the newest stretch if it continues them. Null when it has
   * nothing from the start.
   */
  fetchCached = async (params: URLSearchParams, now = Date.now()): Promise<(Fetched<number> & { covered: Coverage }) | null> => {
    const cache = this.cache
    if (!cache?.generation) return null
    const { lo, hi } = requestedRange(params, now)
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null
    const texts: string[] = []
    let upTo = lo
    for (const d of planDays(lo, hi, now)) {
      const text = await cache.day(d)
      if (text === null) break
      texts.push(text)
      upTo = d + DAY_MS
    }
    const stretch = cache.recent()
    if (stretch && stretch.lo <= upTo && stretch.hi > upTo) {
      texts.push(...(await cache.recentTexts()))
      upTo = stretch.hi
    }
    upTo = Math.min(upTo, hi)
    if (!texts.length || upTo <= lo) return null
    const engine = this.engine()
    const batch = (JSON.parse(engine.stage(texts[0], 0)) as Meta).batch
    for (const t of texts.slice(1)) engine.stage(t, batch)
    const iso = (ms: number) => new Date(ms).toISOString()
    return { window: { start: iso(lo), end: iso(hi), rolling: !params.has('start') }, generation: cache.generation, batch, covered: { lo, hi: upTo } }
  }
}
