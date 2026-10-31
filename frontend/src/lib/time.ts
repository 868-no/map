import { DateTime } from 'luxon'

// All state is UTC; display is in the viewer's zone with a visible indicator.

export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

/** Zone label for a given instant, e.g. "Europe/Oslo (CET, UTC+1)" — changes across DST. */
export function zoneLabel(iso: string | Date, zone = localZone()): string {
  const dt = DateTime.fromJSDate(new Date(iso)).setZone(zone)
  return `${zone} (${dt.offsetNameShort ?? ''}, UTC${dt.toFormat('ZZ')})`
}

export function formatLocal(iso: string | Date | undefined | null, zone = localZone()): string {
  if (!iso) return '—'
  return DateTime.fromJSDate(new Date(iso)).setZone(zone).toFormat('yyyy-LL-dd HH:mm:ss')
}

export function formatShort(iso: string | Date, zone = localZone()): string {
  return DateTime.fromJSDate(new Date(iso)).setZone(zone).toFormat('LLL dd HH:mm')
}

/** Value for <input type="datetime-local"> in the given zone (minute precision). */
/** Compact log time: HH:mm:ss today, otherwise "LLL dd HH:mm". */
export function formatLogTime(iso: string | Date, nowMs = Date.now(), zone = localZone()): string {
  const t = DateTime.fromJSDate(new Date(iso)).setZone(zone)
  return t.hasSame(DateTime.fromMillis(nowMs).setZone(zone), 'day') ? t.toFormat('HH:mm:ss') : t.toFormat('LLL dd HH:mm')
}

export function toLocalInput(iso: string | Date, zone = localZone()): string {
  return DateTime.fromJSDate(new Date(iso)).setZone(zone).toFormat("yyyy-LL-dd'T'HH:mm")
}

/**
 * Parse a datetime-local value in the given zone. Nonexistent local times
 * (spring-forward gap) are shifted forward by Luxon; ambiguous ones
 * (fall-back overlap) resolve to the earlier offset. Returns UTC ISO or null.
 */
export function fromLocalInput(v: string, zone = localZone()): string | null {
  const dt = DateTime.fromISO(v, { zone })
  return dt.isValid ? dt.toUTC().toISO({ suppressMilliseconds: true }) : null
}

/** True when a local wall time occurs twice (DST fall-back), for UI warnings. */
export function isAmbiguousLocal(v: string, zone = localZone()): boolean {
  const dt = DateTime.fromISO(v, { zone })
  if (!dt.isValid) return false
  const wall = dt.toFormat("yyyy-LL-dd'T'HH:mm")
  const ms = dt.toMillis()
  return [ms - 3600_000, ms + 3600_000].some((m) => DateTime.fromMillis(m, { zone }).toFormat("yyyy-LL-dd'T'HH:mm") === wall)
}

export function hoursBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 3600_000
}

export function relativeAge(iso: string | undefined | null, nowMs: number): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
