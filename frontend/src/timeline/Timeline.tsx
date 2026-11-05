// The period: the header's live indicator and the Period panel on the tool
// rail (D-067), which replaced the time bar along the bottom of the map.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Capabilities, Retention } from '../api/types'
import type { SnapshotView } from '../derive/views'
import { useTraffic } from '../state/data'
import { useStore } from '../state/store'
import { serverNow } from '../lib/serverClock'
import { formatLocal, formatShort, fromLocalInput, isAmbiguousLocal, toLocalInput, zoneLabel } from '../lib/time'

const H = 3600_000


export function clampWindow(startMs: number, endMs: number, minMs: number, maxMs: number, maxDurMs: number, minDurMs = H): [number, number] {
  let s = Math.max(startMs, minMs), e = Math.min(endMs, maxMs)
  if (e - s > maxDurMs) s = e - maxDurMs
  if (e - s < minDurMs) {
    if (s + minDurMs <= maxMs) e = s + minDurMs
    else s = e - minDurMs
  }
  return [Math.max(s, minMs), e]
}

/** The selected window and the ways to change it, shared by the indicator and the panel. */
function useWindowModel(caps: Capabilities, retention: Retention | undefined, snapshot: SnapshotView | undefined) {
  const win = useStore((s) => s.win)
  const setLive = useStore((s) => s.setLive)
  const setFixed = useStore((s) => s.setFixed)
  // The server's clock, advanced by the browser's since it was last heard
  // (retention every 5 minutes, live heartbeats): the slider's end is now,
  // and a local clock that runs ahead cannot offer an end the server refuses.
  const now = serverNow()
  // The slider starts where data does (the oldest kept observation), not at
  // the retention limit, which can lie months before anything was recorded.
  const cutoffMs = retention ? Date.parse(retention.configured_cutoff) : now - 180 * 24 * H
  const minMs = retention?.earliest_observation ? Math.max(cutoffMs, Math.floor(Date.parse(retention.earliest_observation) / H) * H) : cutoffMs
  const maxDur = caps.max_window_hours * H
  const shown = snapshot?.meta.window
  const startMs = win.live ? (shown ? Date.parse(shown.start) : now - win.durationH * H) : Date.parse(win.start!)
  const endMs = win.live ? (shown ? Date.parse(shown.end) : now) : Date.parse(win.end!)
  const durMs = endMs - startMs
  const applyFixed = (s: number, e: number) => {
    const [cs, ce] = clampWindow(s, e, minMs, now, maxDur)
    setFixed(new Date(cs).toISOString(), new Date(ce).toISOString())
  }
  const returnToLive = () => setLive(Math.min(Math.round(durMs / H), caps.max_window_hours))
  return { win, setLive, now, minMs, startMs, endMs, durMs, applyFixed, returnToLive }
}

/** Top right of the header: live, paused or historical, and the way back to live. */
export function LiveIndicator({ caps, retention, snapshot, liveOK, onOpen }: { caps: Capabilities; retention: Retention | undefined; snapshot: SnapshotView | undefined; liveOK: boolean; onOpen: () => void }) {
  const { win, durMs, returnToLive } = useWindowModel(caps, retention, snapshot)
  const span = durMs >= 48 * H ? `${Math.round(durMs / (24 * H))}d` : `${Math.round(durMs / H)}h`
  return (
    <div className="live-indicator" role="group" aria-label="Mode">
      <button className={`badge ${win.live ? (liveOK ? 'live' : 'warn') : 'hist'}`} onClick={onOpen}
        title={`${win.live ? (liveOK ? 'Live: the last' : 'Live updates paused: the last') : 'A fixed window of'} ${span}. Change the period.`}>
        {win.live ? (liveOK ? '● LIVE' : '○ LIVE (paused)') : 'HISTORICAL'} <span className="badge-span">{span}</span>
      </button>
      {!win.live && (
        <button onClick={returnToLive} title="Return to the rolling live window">
          Return to live
        </button>
      )}
    </div>
  )
}

/** The Period panel: window length, start and end, sliding through retention, and the window's traffic. */
export function PeriodPanel({ caps, retention, snapshot }: { caps: Capabilities; retention: Retention | undefined; snapshot: SnapshotView | undefined }) {
  // Built only while this panel is open: nothing else shows the traffic strip.
  const traffic = useTraffic().data
  const { win, setLive, now, minMs, startMs, endMs, durMs, applyFixed } = useWindowModel(caps, retention, snapshot)
  const preset = (hours: number) => {
    if (win.live) setLive(hours)
    else applyFixed(endMs - hours * H, endMs)
  }

  // Only buckets with traffic come back: each bar is one bucket wide, placed at its start.
  const { bars, barW, maxRx } = useMemo(() => {
    const b = traffic?.buckets ?? []
    const max = Math.max(1, ...b.map((x) => x.receptions))
    const w = Math.max((goDurationMs(traffic?.bucket ?? '') / durMs) * 1000 - 1, 1)
    return { bars: b.map((x) => ({ x: (Date.parse(x.start) - startMs) / durMs, p: x.packets / max, r: x.receptions / max })), barW: w, maxRx: max }
  }, [traffic, startMs, durMs])

  // The slider shows a draft while dragged and applies it on release (or per
  // key press): every tick as a window of its own would queue a sync each,
  // and one far back in retention would replace the stored live window.
  const [draft, setDraft] = useState<[number, number] | null>(null)
  const [selStart, selEnd] = draft ?? [startMs, endMs]
  const commitDraft = {
    onPointerUp: () => { if (draft) applyFixed(draft[0], draft[1]); setDraft(null) },
    onKeyUp: () => { if (draft) applyFixed(draft[0], draft[1]); setDraft(null) },
    onBlur: () => { if (draft) applyFixed(draft[0], draft[1]); setDraft(null) },
  }
  const [startInput, setStartInput] = useState(toLocalInput(new Date(startMs)))
  const [endInput, setEndInput] = useState(toLocalInput(new Date(endMs)))
  // Follow the window, but not while someone is typing: a live window moves
  // on every rebuild and would wipe a half-typed date.
  const editing = useRef(false)
  useEffect(() => {
    if (editing.current) return
    setStartInput(toLocalInput(new Date(startMs)))
    setEndInput(toLocalInput(new Date(endMs)))
  }, [startMs, endMs])
  const commitInputs = (s = startInput, e = endInput) => {
    const si = fromLocalInput(s), ei = fromLocalInput(e)
    if (si && ei) applyFixed(Date.parse(si), Date.parse(ei))
  }

  const pct = (ms: number) => ((ms - minMs) / (now - minMs)) * 100
  const ambiguous = isAmbiguousLocal(startInput) || isAmbiguousLocal(endInput)

  return (
    <div className="panel period">
      <h3>Length</h3>
      <div className="presets" role="group" aria-label="Window length">
        {(caps.presets ?? []).map((p) => (
          <button key={p.label} aria-pressed={Math.round(durMs / H) === p.hours} onClick={() => preset(p.hours)}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="muted">{win.live ? 'Live: the window ends now and rolls forward.' : 'A fixed window: it does not move until you change it.'}</p>

      <h3>From and to</h3>
      <label className="dt">
        <span>Start</span>
        <input type="datetime-local" value={startInput} onChange={(e) => setStartInput(e.target.value)} onFocus={() => (editing.current = true)} onBlur={() => { editing.current = false; commitInputs() }} onKeyDown={(e) => e.key === 'Enter' && commitInputs()} />
      </label>
      <label className="dt">
        <span>End</span>
        <input type="datetime-local" value={endInput} onChange={(e) => setEndInput(e.target.value)} onFocus={() => (editing.current = true)} onBlur={() => { editing.current = false; commitInputs() }} onKeyDown={(e) => e.key === 'Enter' && commitInputs()} />
      </label>
      <p className="tz" title="Times are shown in your local time zone; the server works in UTC">
        {zoneLabel(new Date(endMs))}
        {ambiguous && <em> · ambiguous local time (DST): earlier offset used</em>}
      </p>

      <h3>Slide through retention</h3>
      <div className="range-row">
        <button aria-label="Move window back" title="Move window back by half its length" onClick={() => applyFixed(startMs - durMs / 2, endMs - durMs / 2)} disabled={startMs <= minMs}>
          ◀
        </button>
        <div className="dual" title={`Selectable: ${formatShort(new Date(minMs))} – now`}>
          <div className="dual-track" />
          <div className="dual-sel" style={{ left: `${pct(selStart)}%`, width: `${Math.max(pct(selEnd) - pct(selStart), 0.3)}%` }} />
          <input type="range" aria-label="Window start" min={minMs} max={now} step={60_000} value={selStart} onChange={(e) => setDraft([+e.target.value, selEnd])} {...commitDraft} />
          <input type="range" aria-label="Window end" min={minMs} max={now} step={60_000} value={selEnd} onChange={(e) => setDraft([selStart, +e.target.value])} {...commitDraft} />
        </div>
        <button aria-label="Move window forward" title="Move window forward by half its length" onClick={() => applyFixed(startMs + durMs / 2, endMs + durMs / 2)} disabled={endMs >= now - 60_000}>
          ▶
        </button>
      </div>
      <p className="muted range-ends"><span>{formatShort(new Date(minMs))}</span><span>now</span></p>

      <h3>Traffic in the window</h3>
      <div className="strip" aria-label="Traffic in window: unique packets (bright) and gateway receptions (dim)">
        <svg viewBox="0 0 1000 40" preserveAspectRatio="none" role="img">
          {bars.map((b, i) => (
            <g key={i}>
              <rect x={b.x * 1000} y={40 - b.r * 38} width={barW} height={b.r * 38} style={{ fill: 'var(--bar-dim)' }} />
              <rect x={b.x * 1000} y={40 - b.p * 38} width={barW} height={b.p * 38} style={{ fill: 'var(--accent)' }} />
            </g>
          ))}
        </svg>
      </div>
      <p className="muted small strip-key">
        <span className="key packets" /> unique packets · <span className="key receptions" /> gateway receptions, per {traffic?.bucket ? goDurationLabel(traffic.bucket) : 'bucket'} · tallest bar {maxRx} receptions
      </p>
      <div className="readout">
        {formatLocal(new Date(startMs))} → {formatLocal(new Date(endMs))}
        <br />
        <small>Times are when this service received each observation (not RF transmission time).</small>
      </div>
    </div>
  )
}

/** A Go duration string from the engine ("15m0s", "1h0m0s") in milliseconds. */
function goDurationMs(s: string): number {
  let ms = 0
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)) ms += +n * (u === 'h' ? 3600_000 : u === 'm' ? 60_000 : 1000)
  return ms
}

/** "15m0s" -> "15 min", "1h0m0s" -> "1 h". */
function goDurationLabel(s: string): string {
  const min = goDurationMs(s) / 60_000
  return min < 60 ? `${min} min` : `${+(min / 60).toFixed(1)} h`
}
