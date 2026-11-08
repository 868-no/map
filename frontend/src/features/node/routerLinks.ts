// A router's link quality chart (D-197): the engine's binned medians as
// TimeChart series, with the readings behind each bin.
import type { RightAxis, Series } from '../../components/TimeChart'
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

/**
 * The router's own noise floor (D-199), binned like its links: dBm on a
 * scale of its own at the right, dashed, in the colour of the line it
 * measures (other routers as it heard them). None without local stats.
 */
export function routerFloorAxis(q: RouterQuality): RightAxis | undefined {
  if (!q.floor?.length) return undefined
  return {
    unit: 'dBm',
    decimals: 0,
    series: [{
      label: 'Its noise floor',
      color: 'var(--warn)',
      dashed: true,
      points: q.floor.map(([t, v]) => [t, v]),
      counts: new Map(q.floor.map(([t, , n]) => [t, n])),
    }],
  }
}

/** A bin width in words: "15 min", "1 h", "6 h". */
export function binWords(ms: number): string {
  return ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`
}
