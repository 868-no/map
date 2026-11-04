// Resizable table columns: a handle on each header's right edge, dragged
// (or moved with the arrow keys) to set that column's width; double-click
// or Home gives the column back its default. Widths are remembered in the
// browser, like the panel's (Settings → Reset clears them).
import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

const MIN_COL = 28
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

/** Column widths for a table: what the user set, else the defaults. */
export function useColumnWidths(key: string, defaults: ColumnDefault[]) {
  const [set, setSet] = useState(() => load(key, defaults.length))
  const update = useCallback((i: number, w: number | null) => {
    setSet((cur) => {
      const next = cur.map((x, k) => (k === i ? (w === null ? null : Math.max(MIN_COL, Math.round(w))) : x))
      store(key, next)
      return next
    })
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
export function ColResize({ label, width, measure, onChange }: { label: string; width: number | null; measure: () => number; onChange: (w: number | null) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const onPointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, w: width ?? measure() }
    document.body.classList.add('resizing-col')
  }
  const onPointerMove = (e: PointerEvent<HTMLSpanElement>) => drag.current && onChange(drag.current.w + e.clientX - drag.current.x)
  const onPointerUp = () => {
    drag.current = null
    document.body.classList.remove('resizing-col')
  }
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    const w = width ?? measure()
    if (e.key === 'ArrowRight') onChange(w + KEY_STEP)
    else if (e.key === 'ArrowLeft') onChange(w - KEY_STEP)
    else if (e.key === 'Home') onChange(null)
    else return
    e.preventDefault()
  }
  return (
    <span className="col-resize" role="separator" aria-orientation="vertical" aria-label={`${label} column width`} tabIndex={0}
      aria-valuenow={width ?? undefined} title="Drag to resize the column (arrow keys too); double-click resets"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onClick={(e) => e.stopPropagation()} onDoubleClick={() => onChange(null)} onKeyDown={onKeyDown} />
  )
}
