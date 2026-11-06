// The worker's range fetch: every row of a window into one staged batch of
// the engine (kept apart from the worker so tests can run it without
// WebAssembly).
import type { Fetched } from './rowStore'
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

/** A whole day was asked for under a generation the server no longer has (409): refetch the range. */
export class GenerationMoved extends Error {}

/** GETs an API URL as text, retrying while the backend is busy; errors are typed as fetchRange's callers expect. */
async function fetchText(url: string): Promise<string> {
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
    return await res.text()
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
  private prefetched = new Map<string, Promise<string>>()
  private slots = limiter(PARALLEL)

  constructor(private engine: () => Stager, private get: (url: string) => Promise<string> = fetchText) {}

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
      if (this.prefetched.has(url)) continue
      const p = this.slots(() => this.get(url))
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
    // A failed request fails the range: the others stop before their next
    // request (even one still waiting for a slot) or at their next page, and the
    // batch is discarded, so no staged rows are stranded in the engine.
    let failed = false
    const run = abandonable(this.slots, () => failed)
    const page = (extra: Record<string, string>) => {
      const p = new URLSearchParams(params)
      for (const [k, v] of Object.entries(extra)) p.set(k, v)
      return run(() => this.get(`/api/v1/observations?${p}`))
    }
    // A day's text: prefetched (asked again if that failed), or fetched now.
    const day = (url: string) => {
      const pre = this.prefetched.get(url)
      this.prefetched.delete(url)
      return pre ? pre.catch(() => run(() => this.get(url))) : run(() => this.get(url))
    }
    const iso = (ms: number) => new Date(ms).toISOString()
    const now = Date.now()
    const { lo, hi } = requestedRange(params, now)
    const days = planDays(lo, hi, now)
    // With whole days, the first request is the part after them (empty when the range ends there).
    const tail: Record<string, string> = days.length ? { since: iso(days[days.length - 1] + DAY_MS) } : {}
    const firstText = page(tail)
    // Not after a 409: the hint is then known to be stale.
    const hint = retry ? this.hint : null
    const early = new Map(hint ? days.map((d) => [d, day(dayUrl(d, hint))]) : [])
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
    const drain = async (meta: Meta, extra: Record<string, string>) => {
      while (meta.more) meta = stage(await page({ ...extra, cursor: meta.next_cursor ?? '' }))
    }
    const tasks: (() => Promise<unknown>)[] = []
    if (first.more) {
      // The rest starts at the first page's cursor instant.
      const bounds = sliceBounds(cursorMs(first.next_cursor), rangeEnd(first.window.end, params.get('until')), SLICES)
      bounds.slice(0, -1).forEach((b, k) =>
        tasks.push(async () => {
          const range = { ...tail, until: iso(bounds[k + 1]) }
          if (k === 0) return drain(first, range) // continues after the first page
          if (b >= bounds[k + 1]) return
          return drain(stage(await page({ ...range, since: iso(b) })), { ...range, since: iso(b) })
        }),
      )
    }
    if (days.length) {
      // Before the first whole day: from the window's start as the server set it.
      const start = Math.max(Date.parse(first.window.start), params.has('since') ? Date.parse(params.get('since')!) : -Infinity)
      if (start < days[0]) {
        const head = { until: iso(days[0]) }
        tasks.push(async () => drain(stage(await page(head)), head))
      }
      // Days asked under a stale hint are dropped (the server answers them 409).
      const asked = hint === first.generation ? early : new Map<number, Promise<string>>()
      for (const d of days) {
        tasks.push(async () => {
          const meta = stage(await (asked.get(d) ?? day(dayUrl(d, first.generation))))
          if (meta.generation !== first.generation) throw new GenerationMoved('observations: a day of another generation')
        })
      }
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
        if (retry) return this.fetchRange(params, false)
        throw new ViewError('upstream', err.reason.message)
      }
      throw err.reason
    }
    return { window: first.window, generation: first.generation, batch }
  }
}
