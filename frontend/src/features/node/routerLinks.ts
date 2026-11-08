// A router's link quality chart (D-197): the engine's binned medians as
// TimeChart series, with the readings behind each bin.
import type { Series } from '../../components/TimeChart'
import type { RouterQuality } from '../../derive/views'

/** Both directions as chart lines: heard by other routers, and hearing them. */
export function routerLinkSeries(q: RouterQuality): Series[] {
  const line = (label: string, color: string, bins: [number, number, number][]): Series => ({
    label,
    color,
    points: bins.map(([t, snr]) => [t, snr]),
    counts: new Map(bins.map(([t, , n]) => [t, n])),
  })
  return [
    line('Heard by other routers', 'var(--accent)', q.heard),
    line('Hearing other routers', 'var(--warn)', q.hearing),
  ]
}

/** A bin width in words: "15 min", "1 h", "6 h". */
export function binWords(ms: number): string {
  return ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`
}
