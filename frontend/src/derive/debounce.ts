type Ms = number | (() => number)
const ms = (v: Ms) => (typeof v === 'function' ? v() : v)

/**
 * Debounce with a ceiling: fn runs once calls have paused for waitMs, but no
 * later than maxWaitMs after the first call it covers, so a steady stream of
 * calls cannot postpone it forever. Either may be a function, read at each
 * call (the wait) or at the first call of a burst (the ceiling).
 */
export function debounce(fn: () => void, waitMs: Ms, maxWaitMs: Ms): () => void {
  let quiet: ReturnType<typeof setTimeout> | undefined
  let ceiling: ReturnType<typeof setTimeout> | undefined
  const fire = () => {
    clearTimeout(quiet)
    clearTimeout(ceiling)
    quiet = ceiling = undefined
    fn()
  }
  return () => {
    clearTimeout(quiet)
    quiet = setTimeout(fire, ms(waitMs))
    ceiling ??= setTimeout(fire, ms(maxWaitMs))
  }
}

/**
 * How long view rebuilds wait for the live stream to pause (quiet) and at
 * most (max), by the rolling window's length: a rebuild costs about the
 * window's row count while one new row changes a long window very little.
 * Up to 6 h: 2 s / 5 s; from 24 h: 10 s / 15 s; linear in between. Fixed
 * windows (null) use the short delays.
 */
export function rebuildDelay(liveHours: number | null): { quietMs: number; maxMs: number } {
  const f = liveHours == null ? 0 : Math.min(Math.max((liveHours - 6) / 18, 0), 1)
  return { quietMs: Math.round(2000 + f * 8000), maxMs: Math.round(5000 + f * 10_000) }
}
