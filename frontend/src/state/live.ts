// The live stream (SSE) for the rolling window: every new row goes to the
// derivation worker, recent radio rows also become pings, and heartbeats
// and reconnects schedule the gap-filling sync.
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { subscribeLive } from '../api/client'
import type { ObsRow } from '../api/types'
import { onTransmissions, sendLiveRows } from '../derive/client'
import { addTransmission, clearPings, painting, PING_MAX_AGE_MS, pingWanted, type Transmission } from '../map/pings'

/** Transmission batches kept for the next frame while the page is not painted. */
const MAX_DEFERRED = 50
import { useLiveEpoch } from './data'
import { apiParams, defaultFilters, useStore, type Filters } from './store'

/**
 * A live row passes the view filters (the stream itself is unfiltered).
 * Mirrors the channel, broker and type part of the engine's filter_fn
 * (frontend/engine/src/views/filters.rs); keep the two in step.
 */
export function passes(r: ObsRow, f: Filters): boolean {
  return (!f.channels.length || (r.c != null && f.channels.includes(r.c))) && (!f.brokers.length || f.brokers.includes(r.b)) && (!f.types.length || f.types.includes(r.y))
}

/**
 * Subscribes while the window is rolling. positions: the drawn markers, for
 * placing pings. Returns whether the stream is up.
 */
export function useLiveStream(positions: RefObject<Map<string, [number, number]>>, onNotice: (text: string) => void): boolean {
  const win = useStore((s) => s.win)
  const limitsReady = useStore((s) => s.limitsReady)
  const filters = useStore((s) => s.filters)
  const bump = useLiveEpoch((s) => s.bump)
  const qc = useQueryClient()
  const [liveOK, setLiveOK] = useState(true)
  const filtersRef = useRef(filters)
  const noticeRef = useRef(onNotice)
  useEffect(() => {
    filtersRef.current = filters
    noticeRef.current = onNotice
  })

  // The worker attributes live rows to transmissions; the animation places them.
  // Animated at once while the page is being painted; otherwise on the next
  // frame, if that comes while the rows are still recent, each on its own
  // timeline: started when it arrived, so after a covered or frozen window
  // gets frames again its last seconds of traffic play out staggered as they
  // happened, mostly already fading, rather than all bursting at once (D-113).
  useEffect(() => {
    // One pending frame and a bounded buffer: a covered window that gets no
    // frames holds at most the last MAX_DEFERRED batches, none older than
    // PING_MAX_AGE_MS when they finally play.
    const deferred: { at: number; ts: Transmission[] }[] = []
    let pending = false
    const flush = () => {
      pending = false
      const now = Date.now(), perf = performance.now()
      for (const d of deferred.splice(0)) if (now - d.at < PING_MAX_AGE_MS) d.ts.forEach((t) => addTransmission(t, positions.current, perf - (now - d.at)))
    }
    onTransmissions((ts) => {
      if (painting()) return ts.forEach((t) => addTransmission(t, positions.current))
      deferred.push({ at: Date.now(), ts })
      if (deferred.length > MAX_DEFERRED) deferred.shift()
      if (!pending) {
        pending = true
        requestAnimationFrame(flush)
      }
    })
  }, [positions])

  // Live updates for the rolling window only. The stream carries every new
  // row (unfiltered: the browser's copy needs them all); filters apply here.
  useEffect(() => {
    if (!win.live || !limitsReady) return
    const params = apiParams({ win, filters: defaultFilters })
    let lastRefresh = Date.now() // the views were just loaded
    let wasLive = true
    let clockOffset = 0 // server time minus local time, from heartbeats
    const unsub = subscribeLive(params, {
      onHeartbeat: (h) => {
        clockOffset = Date.parse(h.now) - Date.now()
        // Every row arrives over the stream; this sync only fills gaps the
        // stream might have left (and slides an idle window), once a minute.
        if (Date.now() - lastRefresh > 60_000) {
          lastRefresh = Date.now()
          bump(h.window.end)
        }
      },
      onDelta: (events) => {
        const rows = events.flatMap((e) => (e.row ? [e.row] : []))
        const f = filtersRef.current
        const now = Date.now() + clockOffset
        // Pings: radio traffic only (not a node's own map report), passing the
        // filters, recent, and only while someone is watching: the tab is
        // visible (D-034, D-048); whether it is being painted is decided when
        // the transmissions come back (D-113).
        const ping = rows.flatMap((r, k) => (r.y !== 'mapreport' && passes(r, f) && pingWanted(r.t, now, document.hidden) ? [k] : []))
        sendLiveRows(rows, ping)
      },
      onStatus: (ok, reason) => {
        setLiveOK(ok)
        // Back after an interruption, or the server dropped events for us
        // (too slow): fetch whatever the stream missed.
        if (ok && (!wasLive || reason === 'lagged')) {
          lastRefresh = Date.now()
          bump(`reconnect:${Date.now()}`)
        }
        wasLive = ok
      },
      onRetention: () => {
        noticeRef.current('Old data was removed by retention; views refreshed.')
        qc.invalidateQueries()
      },
    })
    return () => {
      unsub()
      clearPings()
    }
  }, [win, limitsReady, bump, qc])

  return liveOK
}
