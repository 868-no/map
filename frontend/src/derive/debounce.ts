/**
 * Debounce with a ceiling: fn runs once calls have paused for waitMs, but no
 * later than maxWaitMs after the first call it covers, so a steady stream of
 * calls cannot postpone it forever.
 */
export function debounce(fn: () => void, waitMs: number, maxWaitMs: number): () => void {
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
    quiet = setTimeout(fire, waitMs)
    ceiling ??= setTimeout(fire, maxWaitMs)
  }
}
