// Day, week and month buckets of the server's long-term summaries (D-104,
// D-195), named in the viewer's time zone.

export type Period = 'day' | 'week' | 'month'

/** The viewer's time zone, which the buckets are asked for in. */
export const VIEWER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export const PERIOD_NAME: Record<Period, string> = { day: 'Daily', week: 'Weekly', month: 'Monthly' }

const FORMAT: Record<Period, Intl.DateTimeFormatOptions> = {
  day: { weekday: 'short', day: 'numeric', month: 'short' },
  week: { day: 'numeric', month: 'short' },
  month: { month: 'short', year: 'numeric' },
}

/** Labels for buckets starting at these instants, in zone: "Mon 3 Nov", "week of 3 Nov", "Nov 2026". */
export function periodLabels(starts: readonly string[], period: Period, zone = VIEWER_TZ): string[] {
  const fmt = new Intl.DateTimeFormat(undefined, { ...FORMAT[period], timeZone: zone })
  return starts.map((s) => (period === 'week' ? `week of ${fmt.format(new Date(s))}` : fmt.format(new Date(s))))
}
