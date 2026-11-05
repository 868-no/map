// Recent live traffic, for the open packet log to show at once: views are
// rebuilt only when the stream pauses (§5.3), seconds after a packet's ping
// played. The log inserts what it can tell from the row (own and inbound
// packets) and from the ping attribution (relays) straight away, and the
// next rebuild replaces those rows with the full entries.
import { create } from 'zustand'
import type { ObsRow } from '../api/types'
import type { Transmission } from '../derive/protocol'

/** How long live rows and relays are kept: well past the slowest rebuild. */
export const LIVE_LOG_MS = 120_000
export const MAX_ROWS = 4000

export interface LiveRow { lp: string; t: number; src: string; dst?: string; type: string }
export interface LiveRelay { lp: string; tx: string; at: number }

const BROADCAST = 0xffffffff
export const nodeId = (n: number) => '!' + (n >>> 0).toString(16).padStart(8, '0')

interface LiveLog {
  rows: LiveRow[] // newest last, one per logical packet
  relays: LiveRelay[] // rebroadcasts the pings attributed
  addRows: (rows: ObsRow[]) => void
  addTransmissions: (ts: Transmission[], now?: number) => void
  clear: () => void
}

const prune = <T,>(xs: T[], at: (x: T) => number, now: number) => {
  const keep = xs.filter((x) => now - at(x) < LIVE_LOG_MS)
  return keep.length > MAX_ROWS ? keep.slice(keep.length - MAX_ROWS) : keep
}

export const useLiveLog = create<LiveLog>((set) => ({
  rows: [],
  relays: [],
  addRows: (rows) => {
    if (!rows.length) return
    set((s) => {
      const seen = new Set(s.rows.map((r) => r.lp))
      const add: LiveRow[] = []
      for (const r of rows) {
        if (!r.l || seen.has(r.l)) continue
        seen.add(r.l)
        add.push({ lp: r.l, t: r.t, src: nodeId(r.s), dst: r.d == null ? undefined : r.d === BROADCAST ? 'broadcast' : nodeId(r.d), type: r.y })
      }
      return add.length ? { rows: prune([...s.rows, ...add], (r) => r.t, Date.now()) } : s
    })
  },
  addTransmissions: (ts, now = Date.now()) => {
    // A rebroadcast of a live packet (not a replayed route, an ACK or a gap): the transmitter relayed it.
    const add = ts.filter((t) => t.rebroadcast && !t.replay && !t.delivered && !t.gap).map((t) => ({ lp: t.key.slice(0, t.key.indexOf('|')), tx: t.tx, at: now }))
    if (add.length) set((s) => ({ relays: prune([...s.relays, ...add], (r) => r.at, now) }))
  },
  clear: () => set({ rows: [], relays: [] }),
}))
