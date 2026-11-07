// Pure arithmetic of the worker's range fetch (kept apart from the worker so
// tests need no WebAssembly).

/** Milliseconds of an /observations cursor "<unix µs>.<id>": where the next page starts. */
export function cursorMs(cursor: string | undefined): number {
  return Math.floor(Number((cursor ?? '0').split('.')[0]) / 1000)
}

/**
 * Splits [lo, hi) into `slices` equal time ranges for parallel fetching:
 * slices + 1 ascending bounds, clamped to hi. Trailing slices are empty
 * (equal bounds) when the range is shorter than `slices` milliseconds.
 */
export function sliceBounds(lo: number, hi: number, slices: number): number[] {
  const step = Math.max(Math.ceil((hi - lo) / slices), 1)
  return Array.from({ length: slices + 1 }, (_, k) => Math.min(lo + k * step, hi))
}

/** Where the rest of a range ends: the window end, or `until` when that is earlier. */
export function rangeEnd(windowEnd: string, until: string | null): number {
  return Math.min(Date.parse(windowEnd), until ? Date.parse(until) : Infinity)
}

/** One UTC day. */
export const DAY_MS = 86_400_000
/**
 * A UTC day can no longer change this long after it ends (the server's
 * SettleMargin, D-159): only then is it fetched whole from
 * /observations/day, which every visitor shares through HTTP caches (D-158).
 */
const SETTLE_MS = 30 * 60_000
/** The UTC day of ms as YYYY-MM-DD (the day endpoint's path). */
export function dayName(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The time range [lo, hi) an /observations request asks for, as the browser
 * estimates it: start/end, or a rolling duration ending now, narrowed by
 * since/until. NaN bounds when the parameters say nothing usable.
 */
export function requestedRange(params: URLSearchParams, now: number): { lo: number; hi: number } {
  let lo: number, hi: number
  if (params.has('start') && params.has('end')) {
    lo = Date.parse(params.get('start')!)
    hi = Date.parse(params.get('end')!)
  } else {
    const d = /^(\d+(?:\.\d+)?)h$/.exec(params.get('duration') ?? '')
    hi = now
    lo = d ? now - Number(d[1]) * 3_600_000 : NaN
  }
  if (params.has('since')) lo = Math.max(lo, Date.parse(params.get('since')!))
  if (params.has('until')) hi = Math.min(hi, Date.parse(params.get('until')!))
  return { lo, hi }
}

/**
 * The UTC days (start instants, ascending) of [lo, hi) to fetch whole: every
 * day the range touches that ended at least SETTLE_MS before now, however
 * little of it is needed. A whole day comes from a shared cache (the
 * browser's, Cloudflare, the server's Redis), so its rows outside the range
 * cost transfer, never the database; only what is not settled yet (today)
 * goes through the paged endpoint.
 */
export function planDays(lo: number, hi: number, now: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return []
  const settled = Math.floor((now - SETTLE_MS) / DAY_MS) * DAY_MS // days ending here or earlier are final
  const days: number[] = []
  for (let d = Math.floor(lo / DAY_MS) * DAY_MS; d < hi && d + DAY_MS <= settled; d += DAY_MS) days.push(d)
  return days
}

/** Runs at most n of the functions given to it at once, the rest in order as others finish. */
export function limiter(n: number): <T>(f: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(f: () => Promise<T>): Promise<T> => {
    if (active < n) active++
    else await new Promise<void>((r) => waiting.push(r)) // the slot is handed over, still counted
    try {
      return await f()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

/** Thrown by the tasks of a range that stop because another one failed: never the range's reason. */
export class Abandoned extends Error {}

/**
 * Wraps a limiter so that a request still waiting for its slot when the range
 * has failed throws Abandoned instead of being made.
 */
export function abandonable(run: <T>(f: () => Promise<T>) => Promise<T>, failed: () => boolean): <T>(f: () => Promise<T>) => Promise<T> {
  return (f) =>
    run(() => {
      if (failed()) throw new Abandoned('observations: range abandoned')
      return f()
    })
}

/**
 * Runs a range's tasks together and waits for all of them. The first task to
 * fail calls onFail (the others then stop at their next page, with Abandoned);
 * resolves to that first real failure in time, or null when all succeeded.
 */
export async function settleFirst(tasks: (() => Promise<unknown>)[], onFail: () => void): Promise<{ reason: unknown } | null> {
  let first: { reason: unknown } | null = null
  await Promise.allSettled(
    tasks.map(async (t) => {
      try {
        await t()
      } catch (e) {
        onFail()
        if (!(e instanceof Abandoned)) first ??= { reason: e }
      }
    }),
  )
  return first
}
