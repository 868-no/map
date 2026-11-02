// Camera behaviour: fit to data (on request), fly to a selected node,
// and keep framed content clear of the panel that overlays the map.
import { useCallback, useEffect, useRef, type RefObject } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { Selection } from '../state/store'

type LngLat = [number, number]

/** Pixels of the map covered by the floating header (top) and the open panel (right edge, or the top on phones). */
function covered(container: HTMLElement | null): { top: number; right: number; bottom: number } {
  const head = document.getElementById('topbar')
  const top = head && container ? Math.max(0, head.getBoundingClientRect().bottom - container.getBoundingClientRect().top) : 0
  const panel = document.getElementById('dock')
  if (!panel || panel.hidden || !container) return { top, right: 0, bottom: 0 }
  const a = container.getBoundingClientRect(), b = panel.getBoundingClientRect()
  // The side panel is narrow. On phones it spans most of the width from below
  // the header down: frame content beneath it, unless it leaves too little map.
  if (b.width < a.width * 0.6) return { top, right: Math.max(0, a.right - b.left), bottom: 0 }
  const below = Math.max(0, b.bottom - a.top)
  return { top: a.height - below >= 160 ? Math.max(top, below) : top, right: 0, bottom: 0 }
}

export function useCamera(
  mapRef: RefObject<maplibregl.Map | null>,
  container: RefObject<HTMLDivElement | null>,
  { pos, selection, route }: { pos: Map<string, LngLat>; selection: Selection; route: { key: string; points: LngLat[] } | null },
): { fit: (duration?: number) => void } {
  const fit = useCallback(
    (duration = 600) => {
      const map = mapRef.current
      if (!map || pos.size === 0) return
      const b = new maplibregl.LngLatBounds()
      pos.forEach((p) => b.extend(p))
      const c = covered(container.current)
      map.fitBounds(b, { padding: { top: 30 + c.top, left: 60, right: 60 + c.right, bottom: 60 + c.bottom }, maxZoom: 12, duration })
    },
    [mapRef, container, pos],
  )

  // Fly to a selected node once per selection, centred in the area the side
  // panel leaves free. Positions refresh as live data arrives; that must not
  // pull the view back. Measured on the next frame: this selection may be
  // what opens the panel.
  const flownTo = useRef<string | null>(null)
  useEffect(() => {
    if (selection?.kind !== 'node') {
      flownTo.current = null
      return
    }
    if (!mapRef.current || flownTo.current === selection.id) return
    const p = pos.get(selection.id)
    if (!p) return // not placed yet: fly when it first is
    const id = (flownTo.current = selection.id)
    // Not cancelled by a position refresh; skipped if the selection changed meanwhile.
    requestAnimationFrame(() => {
      if (flownTo.current !== id) return
      const c = covered(container.current)
      mapRef.current?.easeTo({ center: p, zoom: Math.max(mapRef.current.getZoom(), 10), duration: 600, offset: [-c.right / 2, (c.top - c.bottom) / 2] })
    })
  }, [selection, pos, mapRef, container])

  // Frame a packet's route once when it is drawn (not again as data refreshes).
  const framed = useRef<string | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!route) {
      framed.current = null
      return
    }
    if (!map || route.points.length === 0 || framed.current === route.key) return
    framed.current = route.key
    const b = new maplibregl.LngLatBounds()
    route.points.forEach((p) => b.extend(p))
    const c = covered(container.current)
    map.fitBounds(b, { padding: { top: 40 + c.top, left: 80, right: 80 + c.right, bottom: 80 + c.bottom }, maxZoom: 13, duration: 600 })
  }, [route, mapRef, container])

  return { fit }
}
