// The watchlist (D-192): nodes this viewer keeps an eye on, kept in this
// browser only (no account, nothing sent anywhere), and whether to be told
// by a browser notification when one changes while the map is open.
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import type { Issue } from '../derive/views'
import { useWindowParams } from './data'
import type { Watched } from '../derive/views'

const KEY = 'meshmap.watch'
/** More would make the list a second node list; the view is built per change. */
const WATCH_MAX = 30
/** Battery (%) at which a watched node's battery is called low. */
export const WATCH_BATTERY_LOW = 20

interface Saved {
  ids: string[]
  notify: boolean
}

function load(): Saved {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null
    if (v && Array.isArray(v.ids)) return { ids: v.ids.filter((x): x is string => typeof x === 'string' && /^![0-9a-f]{8}$/.test(x)).slice(0, WATCH_MAX), notify: v.notify === true }
  } catch {
    /* storage unavailable or corrupt: start empty */
  }
  return { ids: [], notify: false }
}

function save(s: Saved) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable: the list lasts for this visit */
  }
}

interface WatchState extends Saved {
  toggle: (id: string) => void
  setNotify: (on: boolean) => void
}

export const useWatch = create<WatchState>((set, get) => ({
  ...(typeof window === 'undefined' ? { ids: [], notify: false } : load()),
  toggle: (id) => {
    const { ids, notify } = get()
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id].slice(-WATCH_MAX)
    save({ ids: next, notify })
    set({ ids: next })
  },
  setNotify: (on) => {
    save({ ids: get().ids, notify: on })
    set({ notify: on })
  },
}))

/** Whether the browser can show notifications at all. */
export const canNotify = () => typeof window !== 'undefined' && 'Notification' in window

/** Asks for permission when needed; resolves with whether notifications may be shown. */
export async function allowNotifications(): Promise<boolean> {
  if (!canNotify()) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  return (await Notification.requestPermission()) === 'granted'
}

/** What changed for a watched node between two updates, as notification texts. */
export function watchChanges(prev: Watched | undefined, next: Watched, issues: Issue[], seenIssues: Set<string>): string[] {
  const out: string[] = []
  if (prev) {
    if (!prev.quiet && next.quiet) out.push(`Not heard for ${hours(next.quiet_ms)}; it is usually heard every ${hours(next.usual_gap_ms)}.`)
    if (prev.quiet && !next.quiet) out.push('Heard again.')
    if ((prev.battery ?? 101) > WATCH_BATTERY_LOW && next.battery !== undefined && next.battery <= WATCH_BATTERY_LOW) out.push(`Battery down to ${Math.round(next.battery)} %.`)
  }
  for (const i of issues) {
    const key = `${i.kind}|${i.node}`
    if (i.severity !== 'notice' && !seenIssues.has(key) && prev) out.push(`${i.severity === 'problem' ? 'Problem' : 'Warning'}: ${i.summary}.`)
  }
  return out
}

function hours(ms: number | undefined): string {
  if (ms === undefined) return 'a while'
  const h = ms / 3_600_000
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h < 10 ? h.toFixed(1) : Math.round(h)} h` : `${Math.round(h / 24)} days`
}

/**
 * Notifies about watched nodes while the map is open in a live window: the
 * first data is the baseline, and only later changes notify. A new window
 * starts a new baseline.
 */
export function useWatchAlerts(watched: Watched[] | undefined, issues: Issue[] | undefined, live: boolean) {
  const notify = useWatch((s) => s.notify)
  const { identity } = useWindowParams()
  const prev = useRef<{ identity: string; nodes: Map<string, Watched>; issues: Set<string> } | null>(null)
  useEffect(() => {
    if (!watched || !issues) return
    const nodes = new Map(watched.map((w) => [w.id, w]))
    const mine = new Set(watched.map((w) => w.id))
    const relevant = issues.filter((i) => mine.has(i.node))
    const keys = new Set(relevant.map((i) => `${i.kind}|${i.node}`))
    const before = prev.current?.identity === identity ? prev.current : null
    prev.current = { identity, nodes, issues: keys }
    if (!before || !live || !notify || !canNotify() || Notification.permission !== 'granted') return
    for (const w of watched) {
      const lines = watchChanges(before.nodes.get(w.id), w, relevant.filter((i) => i.node === w.id), before.issues)
      if (lines.length) new Notification(`${w.long_name || w.short_name || w.id} (868.no Map)`, { body: lines.join('\n'), tag: `meshmap-${w.id}` })
    }
  }, [watched, issues, live, notify, identity])
}
