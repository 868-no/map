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
