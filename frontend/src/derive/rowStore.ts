// The browser's copy of the packet log covers one contiguous time range,
// fetched incrementally from /api/v1/observations. Rows are immutable, so a
// range fetched once never needs fetching again; a rolling window only asks
// for what arrived since the last sync. This class decides what to fetch and
// what is covered; the rows themselves live in a Backend (the WebAssembly
// engine in the worker, a plain array in tests).

/** Re-fetch this much before the end of what we hold: rows may commit slightly after their observed_at. */
export const OVERLAP_MS = 2 * 60_000
/** Rows older than this before the newest requested window end are dropped: the longest window (14 days) and a day. */
const KEEP_MS = 15 * 24 * 3_600_000
/** Hard cap on rows held; beyond it the store keeps only the requested window. */
const MAX_ROWS = 750_000

export type WindowReq = { live: true; durationH: number } | { live: false; start: string; end: string }

export interface WindowEcho {
  start: string
  end: string
  rolling: boolean
}

/** A fetched range: the window it belongs to and a batch of rows not yet merged. */
export interface Fetched<B> {
  window: WindowEcho
  generation: string
  batch: B
}

/** Fetches every page for the given parameters into one batch; an abort fails it. */
export type FetchRange<B> = (params: URLSearchParams, signal?: AbortSignal) => Promise<Fetched<B>>

/** Where rows live. B is a fetched batch, L a set of live rows. */
export interface Backend<B, L> {
  commit(batch: B): number // rows added (new ids only)
  discard(batch: B): void
  addLive(rows: L, lo: number): number // rows at or after lo, new ids only
  reset(): void
  trimBefore(t: number): void
  /** Keep only rows in [lo, hi), in freshly reserved memory where the backend can (the engine: a new instance). */
  keepOnly(lo: number, hi: number): void
  newestT(): number // 0 when empty
  count(): number
}

export interface Coverage {
  lo: number
  hi: number
}

/** What a cache has of a range, offline: a batch, and the range it holds every row of. */
export type FetchCached<B> = (params: URLSearchParams) => Promise<(Fetched<B> & { covered: Coverage }) | null>

export interface Synced {
  start: number
  end: number
  rolling: boolean
}

const iso = (ms: number) => new Date(ms).toISOString()

/** A window's /observations parameters before narrowing (since/until). */
export function baseParams(req: WindowReq): URLSearchParams {
  return req.live ? new URLSearchParams({ duration: `${req.durationH}h` }) : new URLSearchParams({ start: req.start, end: req.end })
}

export class RowStore<B, L> {
  cov: Coverage | null = null
  generation: string | null = null
  /** The window last synced: the next one releases what it cannot use unless it contains it. */
  private last: { req: WindowReq; start: number; end: number } | null = null
  /** The running sync's abort, passed to every fetch it makes. */
  private signal: AbortSignal | undefined

  constructor(public rows: Backend<B, L>, private fetchRange: FetchRange<B>, private fetchCached?: FetchCached<B>) {}

  private reset(f: Fetched<B>, cov: Coverage) {
    this.rows.reset()
    this.generation = f.generation
    this.commit(f.batch)
    this.cov = cov
  }

  private commit(batch: B) {
    this.rows.commit(batch)
  }

  private trim(before: number) {
    if (!this.cov || this.cov.lo >= before) return
    this.rows.trimBefore(before)
    this.cov.lo = before
  }

  private get(params: URLSearchParams, extra: Record<string, string> = {}): Promise<Fetched<B>> {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(extra)) p.set(k, v)
    return this.fetchRange(p, this.signal)
  }

  /**
   * Before syncing req: when it does not contain the last window (a shorter
   * one, or one earlier, later or only partly overlapping), keep only the rows
   * it can use, in fresh memory (Backend.keepOnly), so a long window viewed
   * once does not stay reserved. A rolling window that keeps or grows its
   * length contains its earlier self, though it has moved on since.
   */
  private release(req: WindowReq, now: number) {
    const last = this.last, cov = this.cov
    if (!last || !cov) return
    // A rolling window's start by this clock, a minute early: the server's may lag it.
    const lo = req.live ? now - req.durationH * 3_600_000 - 60_000 : Date.parse(req.start)
    const hi = req.live ? Infinity : Date.parse(req.end)
    const contains = req.live && last.req.live ? req.durationH >= last.req.durationH : lo <= last.start && hi >= last.end
    if (contains) return
    const keepLo = Math.max(cov.lo, lo), keepHi = Math.min(cov.hi, hi)
    if (keepLo === cov.lo && this.rows.newestT() < hi) return // nothing held outside it
    if (keepLo < keepHi) {
      this.rows.keepOnly(keepLo, hi) // a rolling window also keeps streamed rows past the coverage mark
      this.cov = { lo: keepLo, hi: keepHi }
    } else {
      this.rows.keepOnly(lo, lo) // nothing held is usable
      this.cov = null
    }
  }

  /**
   * Bring the store up to date for req; returns the window's bounds. An
   * abort fails it like a failed fetch: what is held stays consistent (each
   * fetch is committed whole or discarded), only not up to date.
   */
  async sync(req: WindowReq, now = Date.now(), signal?: AbortSignal): Promise<Synced> {
    signal?.throwIfAborted() // before release: a sync nobody waits for copies nothing
    this.signal = signal
    try {
      return await this.syncing(req, now)
    } finally {
      this.signal = undefined
    }
  }

  private async syncing(req: WindowReq, now: number): Promise<Synced> {
    this.release(req, now)
    const base = baseParams(req)
    const cov = this.cov
    let S: number, E: number
    const rolling = req.live
    if (!req.live) {
      S = Date.parse(req.start)
      E = Date.parse(req.end)
      if (cov && this.generation && S < cov.hi && E > cov.lo) {
        if (E > cov.hi) await this.extend(await this.get(base, { since: iso(cov.hi - OVERLAP_MS) }), base)
        if (S < cov.lo) await this.extend(await this.get(base, { until: iso(cov.lo) }), base)
        if (this.cov) this.cov = { lo: Math.min(this.cov.lo, S), hi: Math.max(this.cov.hi, E) }
      } else {
        this.reset(await this.get(base), { lo: S, hi: E })
      }
    } else {
      const narrowed = !!(cov && this.generation)
      let f = await this.get(base, narrowed ? { since: iso(cov!.hi - OVERLAP_MS) } : {})
      S = Date.parse(f.window.start)
      E = Date.parse(f.window.end)
      if (narrowed && (f.generation !== this.generation || cov!.lo >= E)) {
        this.rows.discard(f.batch)
        f = await this.get(base) // nothing held is usable
        S = Date.parse(f.window.start)
        E = Date.parse(f.window.end)
        this.reset(f, { lo: S, hi: E })
      } else if (!narrowed || cov!.hi - OVERLAP_MS <= S) {
        // The server clamped `since` to the window start: f is the whole window.
        this.reset(f, { lo: S, hi: E })
      } else {
        this.commit(f.batch)
        this.cov = { lo: cov!.lo, hi: Math.max(cov!.hi, E) }
        if (S < cov!.lo) {
          // Also fetch the older part, as a fixed window equal to the rolling one.
          const fixed = new URLSearchParams({ start: f.window.start, end: f.window.end })
          await this.extend(await this.get(fixed, { until: iso(cov!.lo) }), fixed)
          if (this.cov) this.cov.lo = Math.min(this.cov.lo, S)
        }
      }
    }
    this.trim(E - KEEP_MS)
    // Over the cap with rows from before the window: only the window stays (a
    // rolling one with the streamed rows past its end). Not when the window
    // alone is over it: that would copy the engine again on every sync.
    if (this.rows.count() > MAX_ROWS && this.cov && this.cov.lo < S) {
      this.rows.keepOnly(S, rolling ? Infinity : E)
      this.cov = { lo: S, hi: rolling ? this.cov.hi : E }
    }
    this.last = { req, start: S, end: E }
    return { start: S, end: E, rolling }
  }

  /** Merge a partial fetch; a new generation (decoder or configuration change) restarts from scratch. */
  private async extend(f: Fetched<B>, base: URLSearchParams) {
    if (f.generation !== this.generation) {
      this.rows.discard(f.batch)
      const full = await this.get(base)
      this.reset(full, { lo: Date.parse(full.window.start), hi: Date.parse(full.window.end) })
      return
    }
    this.commit(f.batch)
  }

  /**
   * Merge rows streamed live. They extend what is held without moving the
   * coverage mark: the next sync (gap filler) confirms the range. Returns
   * whether anything was added.
   */
  addLive(rows: L): boolean {
    if (!this.cov) return false
    return this.rows.addLive(rows, this.cov.lo) > 0
  }

  /**
   * Offline, when what is held does not reach back to the window's start (a
   * cold start, or a longer window than the one held): takes what the cache
   * has of the window from its start, next to what is held when they meet,
   * else instead of it when it covers more. Returns whether anything is held.
   */
  async fromCache(req: WindowReq, now = Date.now()): Promise<boolean> {
    const cov = this.cov
    const lo = req.live ? now - req.durationH * 3_600_000 : Date.parse(req.start)
    if (cov && cov.lo <= lo) return true
    const f = await this.fetchCached?.(baseParams(req))
    if (!f) return !!cov
    const c = f.covered
    if (cov && f.generation === this.generation && c.lo <= cov.hi && c.hi >= cov.lo) {
      this.commit(f.batch)
      this.cov = { lo: Math.min(cov.lo, c.lo), hi: Math.max(cov.hi, c.hi) }
    } else if (!cov || c.hi - c.lo > cov.hi - cov.lo) {
      this.rows.reset()
      this.generation = f.generation
      this.commit(f.batch)
      this.cov = c
    } else {
      this.rows.discard(f.batch)
    }
    return true
  }

  /** The window's bounds from what is held, without the network (offline). */
  offline(req: WindowReq, now = Date.now(), quantumMs = 10_000): Synced | null {
    if (!this.cov) return null
    const E = req.live ? Math.floor(now / quantumMs) * quantumMs : Date.parse(req.end)
    const S = req.live ? E - req.durationH * 3_600_000 : Date.parse(req.start)
    if (S >= this.cov.hi || E <= this.cov.lo) return null
    return { start: S, end: E, rolling: req.live }
  }
}
