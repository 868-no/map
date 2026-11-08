// All state is UTC; display is in the viewer's zone with a visible indicator.
// Plain Intl: the zone rules come from the browser, as they did through Luxon.

// The viewer's zone, resolved once: building a formatter to ask costs as
// much as the formatting it serves, and every default argument below asks.
let zone: string | undefined
const localZone = (): string => (zone ??= Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')

const MIN = 60_000
const pad = (n: number, w = 2) => String(n).padStart(w, '0')

// Formatters are costly to build: one of each per zone.
const cache = new Map<string, Intl.DateTimeFormat>()
function fmt(kind: 'parts' | 'month' | 'name', zone: string): Intl.DateTimeFormat {
  const key = `${kind}|${zone}`
  let f = cache.get(key)
  if (!f) {
    const opts: Intl.DateTimeFormatOptions =
      kind === 'parts'
        ? { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }
        : kind === 'month'
          ? { month: 'short' } // the viewer's locale, as Luxon's "LLL"
          : { timeZoneName: 'short' }
    f = new Intl.DateTimeFormat(kind === 'parts' ? 'en-US' : undefined, { ...opts, timeZone: zone })
    cache.set(key, f)
  }
  return f
}

interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }

/** The wall-clock time at an instant in a zone. */
function wall(ms: number, zone: string): Wall {
  const p: Record<string, number> = {}
  for (const x of fmt('parts', zone).formatToParts(ms)) if (x.type !== 'literal') p[x.type] = Number(x.value)
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second }
}

/** The zone's UTC offset at an instant, in minutes. */
function offset(ms: number, zone: string): number {
  const w = wall(ms, zone)
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000) / MIN)
}

const ymd = (w: Wall) => `${w.y}-${pad(w.mo)}-${pad(w.d)}`
const hm = (w: Wall) => `${pad(w.h)}:${pad(w.mi)}`
const ms = (iso: string | Date) => new Date(iso).getTime()
const month = (t: number, zone: string) => fmt('month', zone).format(t)

/** Zone label for a given instant, e.g. "Europe/Oslo (CET, UTC+1)" — changes across DST. */
export function zoneLabel(iso: string | Date, zone = localZone()): string {
  const t = ms(iso)
  const name = fmt('name', zone).formatToParts(t).find((x) => x.type === 'timeZoneName')?.value ?? ''
  const o = offset(t, zone)
  const a = Math.abs(o)
  return `${zone} (${name}, UTC${o < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)})`
}

export function formatLocal(iso: string | Date | undefined | null, zone = localZone()): string {
  if (!iso) return '—'
  const w = wall(ms(iso), zone)
  return `${ymd(w)} ${hm(w)}:${pad(w.s)}`
}

export function formatShort(iso: string | Date, zone = localZone()): string {
  const t = ms(iso)
  const w = wall(t, zone)
  return `${month(t, zone)} ${pad(w.d)} ${hm(w)}`
}

/**
 * Writes the time marks the engine puts in sentences ("{{t:<Unix ms>}}",
 * engine util::time_mark) in the viewer's time zone, e.g. "Nov 01 06:44".
 */
export function localizeTimes(text: string, zone = localZone()): string {
  return text.replace(/\{\{t:(-?\d+)\}\}/g, (_, t: string) => formatShort(new Date(Number(t)), zone))
}

/** Compact log time: HH:mm:ss today, otherwise "LLL dd HH:mm". */
export function formatLogTime(iso: string | Date, nowMs = Date.now(), zone = localZone()): string {
  const w = wall(ms(iso), zone)
  return ymd(w) === today(nowMs, zone) ? `${hm(w)}:${pad(w.s)}` : formatShort(iso, zone)
}

// Today's date per zone, worked out once a minute: a log formats hundreds of rows against it.
let todayMemo = { minute: NaN, zone: '', ymd: '' }
function today(nowMs: number, zone: string): string {
  const minute = Math.floor(nowMs / MIN)
  if (minute !== todayMemo.minute || zone !== todayMemo.zone) todayMemo = { minute, zone, ymd: ymd(wall(nowMs, zone)) }
  return todayMemo.ymd
}

/** Value for <input type="datetime-local"> in the given zone (minute precision). */
export function toLocalInput(iso: string | Date, zone = localZone()): string {
  const w = wall(ms(iso), zone)
  return `${ymd(w)}T${hm(w)}`
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/

/**
 * The instants a datetime-local value names in a zone: none when it does not
 * parse, one normally, two (earlier first) when it occurs twice (fall-back),
 * and none either for a time skipped by spring-forward, with `gap` set to
 * that time shifted forward by the jump.
 */
function resolveLocal(v: string, zone: string): { at: number[]; gap?: number } | null {
  const m = LOCAL_INPUT.exec(v)
  if (!m) return null
  const [y, mo, d, h, mi, s = 0] = m.slice(1, 7).map((x) => Number(x ?? 0))
  const local = Date.UTC(y, mo - 1, d, h, mi, s, Number((m[7] ?? '').padEnd(3, '0')))
  const back = new Date(local)
  // Out-of-range fields (Feb 30, 25:00) would roll over: reject them.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) return null
  // The offsets either side of this wall time; real zones change at most once a day.
  const offs = [...new Set([offset(local - 1440 * MIN, zone), offset(local + 1440 * MIN, zone)])].sort((a, b) => b - a)
  const at = offs.filter((o) => offset(local - o * MIN, zone) === o).map((o) => local - o * MIN)
  return at.length ? { at } : { at, gap: local - Math.min(...offs) * MIN }
}

/**
 * Parse a datetime-local value in the given zone. Nonexistent local times
 * (spring-forward gap) are shifted forward by the jump; ambiguous ones
 * (fall-back overlap) resolve to the earlier instant. Returns UTC ISO or null.
 */
export function fromLocalInput(v: string, zone = localZone()): string | null {
  const r = resolveLocal(v, zone)
  if (!r) return null
  return new Date(r.at[0] ?? r.gap!).toISOString().replace('.000Z', 'Z')
}

/** True when a local wall time occurs twice (DST fall-back), for UI warnings. */
export function isAmbiguousLocal(v: string, zone = localZone()): boolean {
  return (resolveLocal(v, zone)?.at.length ?? 0) > 1
}

export function relativeAge(iso: string | undefined | null, nowMs: number): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
