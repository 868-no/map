// Resizable table columns: a handle on each header's right edge, dragged
// (or moved with the arrow keys) to set that column's width; double-click
// or Home gives the column back its default. Widths are remembered in the
// browser, like the panel's (Settings → Reset clears them).
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

const MIN_COL = 28
/** The widest a column is set to (also the separator's aria-valuemax). */
const MAX_COL = 1200
const KEY_STEP = 10
/** What a column sharing what is left keeps at least: widening another scrolls the table instead. */
const MIN_SHARED = 32

/** A column's default width in pixels, or null to share what is left. */
export type ColumnDefault = number | null

function load(key: string, n: number): (number | null)[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown
    if (Array.isArray(v) && v.length === n) return v.map((w) => (typeof w === 'number' && w >= MIN_COL ? Math.round(w) : null))
  } catch {
    /* unreadable or unavailable: the defaults */
  }
  return Array(n).fill(null)
}

function store(key: string, w: (number | null)[]) {
  try {
    if (w.every((x) => x === null)) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(w))
  } catch {
    /* storage unavailable: the widths last for this visit */
  }
}

const clamp = (w: number) => Math.min(MAX_COL, Math.max(MIN_COL, Math.round(w)))

/**
 * Column widths for a table: what the user set, else the defaults.
 * `update(i, w, persist)` sets column i; widths are saved only when `persist`
 * (a drag's end, a key, a reset), not on every pointer move.
 */
export function useColumnWidths(key: string, defaults: ColumnDefault[]) {
  const [set, setSet] = useState(() => load(key, defaults.length))
  // The widths as last set, for saving without a side effect in a state updater.
  const latest = useRef(set)
  const update = useCallback((i: number, w: number | null, persist = true) => {
    const cur = latest.current
    const v = w === null ? null : clamp(w)
    if (cur[i] !== v) {
      const next = cur.map((x, k) => (k === i ? v : x))
      latest.current = next
      setSet(next)
    }
    if (persist) store(key, latest.current)
  }, [key])
  const widths = defaults.map((d, i) => set[i] ?? d)
  // The table is at least this wide (in a horizontally scrolling wrapper),
  // so widening one column never squeezes the shared ones to nothing.
  const minWidth = widths.reduce<number>((n, w) => n + (w ?? MIN_SHARED), 0)
  return { widths, update, minWidth }
}

/**
 * The drag handle at a header cell's right edge. `measure` gives the
 * column's rendered width, for a column sharing what is left.
 */
export function ColResize({ label, width, measure, onChange }: {
  label: string
  width: number | null
  measure: () => number
  /** `persist`: the change is final (drag ended, key, reset) and is saved. */
  onChange: (w: number | null, persist: boolean) => void
}) {
  const drag = useRef<{ x: number; w: number; last: number | null } | null>(null)
  // The rendered width of a column sharing what is left, for aria-valuenow.
  const [measured, setMeasured] = useState<number | null>(null)
  // Unmounted mid-drag (the table went away): give the page its text selection back.
  useEffect(() => {
    const d = drag
    return () => {
      if (d.current) document.body.classList.remove('resizing-col')
    }
  }, [])
  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, w: width ?? measure(), last: null }
    document.body.classList.add('resizing-col')
  }
  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    if (!drag.current) return
    drag.current.last = drag.current.w + e.clientX - drag.current.x
    onChange(drag.current.last, false)
  }
  // The drag's end (or cancel) saves the width it reached.
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    document.body.classList.remove('resizing-col')
    if (d?.last != null) onChange(d.last, true)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    const w = width ?? measure()
    if (e.key === 'ArrowRight') onChange(w + KEY_STEP, true)
    else if (e.key === 'ArrowLeft') onChange(w - KEY_STEP, true)
    else if (e.key === 'Home') onChange(null, true)
    else return
    e.preventDefault()
    // Once the table has laid the new width out: what a shared column now measures.
    requestAnimationFrame(() => setMeasured(Math.round(measure())))
  }
  return (
    <span className="col-resize" role="separator" aria-orientation="vertical" aria-label={`${label} column width`} tabIndex={0}
      aria-valuenow={width ?? measured ?? undefined} aria-valuemin={MIN_COL} aria-valuemax={MAX_COL}
      title="Drag to resize the column (arrow keys too); double-click resets"
      onFocus={() => setMeasured(Math.round(measure()))}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onClick={(e) => e.stopPropagation()} onDoubleClick={() => onChange(null, true)} onKeyDown={onKeyDown} />
  )
}
