// The browser's copy of the packet log: decoded observations covering one
// contiguous time range, fetched incrementally from /api/v1/observations.
// Rows are immutable, so a range fetched once never needs fetching again;
// a rolling window only asks for what arrived since the last sync.
import type { ObsRow, ObservationsBody } from '../api/types'

/** Re-fetch this much before the end of what we hold: rows may commit slightly after their observed_at. */
export const OVERLAP_MS = 2 * 60_000
/** Rows older than this before the newest requested window end are dropped. */
export const KEEP_MS = 8 * 24 * 3_600_000
/** Hard cap on rows held; beyond it the store keeps only the requested window. */
export const MAX_ROWS = 750_000

export type WindowReq = { live: true; durationH: number } | { live: false; start: string; end: string }

export interface Fetched {
  window: ObservationsBody['window']
  generation: string
  rows: ObsRow[]
}

/** Fetches every page for the given parameters. */
export type FetchRange = (params: URLSearchParams) => Promise<Fetched>

export interface Coverage {
  lo: number
  hi: number
}

/** Persistence hooks (IndexedDB in the worker; absent in tests). */
export interface StoreSink {
  added(rows: ObsRow[]): void
  removedBefore(t: number): void
  reset(): void
  meta(cov: Coverage | null, generation: string | null): void
}

export interface Synced {
  start: number
  end: number
  rolling: boolean
  rows: ObsRow[] // in [start, end), ordered by (t, id)
}

const byTime = (a: ObsRow, b: ObsRow) => a.t - b.t || a.i - b.i

export class RowStore {
  rows: ObsRow[] = []
  ids = new Set<number>()
  cov: Coverage | null = null
  generation: string | null = null

  constructor(private fetchRange: FetchRange, public sink?: StoreSink) {}

  /** Restore persisted state. */
  load(rows: ObsRow[], cov: Coverage | null, generation: string | null) {
    this.rows = rows.sort(byTime)
    this.ids = new Set(rows.map((r) => r.i))
    this.cov = rows.length || cov ? cov : null
    this.generation = generation
  }

  private reset(f: Fetched, cov: Coverage) {
    this.rows = []
    this.ids.clear()
    this.sink?.reset()
    this.generation = f.generation
    this.merge(f.rows)
    this.cov = cov
  }

  private merge(rows: ObsRow[]) {
    const fresh = rows.filter((r) => !this.ids.has(r.i))
    if (fresh.length === 0) return
    for (const r of fresh) this.ids.add(r.i)
    // Mostly appends of already ordered rows: cheap for the engine's merge sort.
    this.rows = this.rows.concat(fresh).sort(byTime)
    this.sink?.added(fresh)
  }

  private trim(before: number) {
    if (!this.cov || this.cov.lo >= before) return
    const i = this.lowerBound(before)
    for (const r of this.rows.slice(0, i)) this.ids.delete(r.i)
    this.rows = this.rows.slice(i)
    this.cov.lo = before
    this.sink?.removedBefore(before)
  }

  private lowerBound(t: number): number {
    let lo = 0, hi = this.rows.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.rows[mid].t < t) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Rows with observed_at in [start, end). */
  slice(start: number, end: number): ObsRow[] {
    return this.rows.slice(this.lowerBound(start), this.lowerBound(end))
  }

  private base(req: WindowReq): URLSearchParams {
    return req.live ? new URLSearchParams({ duration: `${req.durationH}h` }) : new URLSearchParams({ start: req.start, end: req.end })
  }

  private async get(params: URLSearchParams, extra: Record<string, string> = {}): Promise<Fetched> {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(extra)) p.set(k, v)
    return this.fetchRange(p)
  }

  /** Bring the store up to date for req and return the window's rows. */
  async sync(req: WindowReq): Promise<Synced> {
    const base = this.base(req)
    const cov = this.cov
    let S: number, E: number, rolling: boolean
    if (!req.live) {
      S = Date.parse(req.start)
      E = Date.parse(req.end)
      rolling = false
      if (cov && this.generation && S < cov.hi && E > cov.lo) {
        if (E > cov.hi) await this.extend(await this.get(base, { since: iso(cov.hi - OVERLAP_MS) }), base)
        if (S < cov.lo) await this.extend(await this.get(base, { until: iso(cov.lo) }), base)
        if (this.cov) this.cov = { lo: Math.min(this.cov.lo, S), hi: Math.max(this.cov.hi, E) }
      } else {
        const f = await this.get(base)
        this.reset(f, { lo: S, hi: E })
      }
    } else {
      rolling = true
      const narrowed = !!(cov && this.generation)
      let f = await this.get(base, narrowed ? { since: iso(cov!.hi - OVERLAP_MS) } : {})
      S = Date.parse(f.window.start)
      E = Date.parse(f.window.end)
      if (narrowed && (f.generation !== this.generation || cov!.lo >= E)) {
        f = await this.get(base) // nothing held is usable
        S = Date.parse(f.window.start)
        E = Date.parse(f.window.end)
        this.reset(f, { lo: S, hi: E })
      } else if (!narrowed || cov!.hi - OVERLAP_MS <= S) {
        // The server clamped `since` to the window start: f is the whole window.
        this.reset(f, { lo: S, hi: E })
      } else {
        this.merge(f.rows)
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
    if (this.rows.length > MAX_ROWS) {
      const keep = this.slice(S, E)
      this.rows = []
      this.ids.clear()
      this.sink?.reset()
      this.merge(keep)
      this.cov = { lo: S, hi: E }
    }
    this.sink?.meta(this.cov, this.generation)
    return { start: S, end: E, rolling, rows: this.slice(S, E) }
  }

  /** Merge a partial fetch; a new generation (decoder or configuration change) restarts from scratch. */
  private async extend(f: Fetched, base: URLSearchParams) {
    if (f.generation !== this.generation) {
      const full = await this.get(base)
      const w = full.window
      this.reset(full, { lo: Date.parse(w.start), hi: Date.parse(w.end) })
      return
    }
    this.merge(f.rows)
  }

  /**
   * Merge rows streamed live. They extend what is held without moving the
   * coverage mark: the next sync (gap filler) confirms the range. Returns
   * whether anything was added.
   */
  addLive(rows: ObsRow[]): boolean {
    if (!this.cov) return false
    const n = this.rows.length
    this.merge(rows.filter((r) => r.t >= this.cov!.lo))
    return this.rows.length > n
  }

  /** Window rows from what is held, without the network (offline). */
  offline(req: WindowReq, now = Date.now(), quantumMs = 10_000): Synced | null {
    if (!this.cov) return null
    const E = req.live ? Math.floor(now / quantumMs) * quantumMs : Date.parse(req.end)
    const S = req.live ? E - req.durationH * 3_600_000 : Date.parse(req.start)
    if (S >= this.cov.hi || E <= this.cov.lo) return null
    return { start: S, end: E, rolling: req.live, rows: this.slice(S, E) }
  }
}

const iso = (ms: number) => new Date(ms).toISOString()
