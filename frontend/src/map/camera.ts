// Camera behaviour: fit to data (also once at start), fly to a selected node,
// and keep framed content clear of the panel that overlays the map.
import { useCallback, useEffect, useRef, type RefObject } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { Capabilities } from '../api/types'
import type { Selection } from '../state/store'

type LngLat = [number, number]

/** Pixels of the map covered by the open panel (right edge, or bottom sheet). */
function covered(container: HTMLElement | null): { right: number; bottom: number } {
  const panel = document.getElementById('dock')
  if (!panel || panel.hidden || !container) return { right: 0, bottom: 0 }
  const a = container.getBoundingClientRect(), b = panel.getBoundingClientRect()
  // The side panel is narrow; the phone's bottom card spans most of the width.
  return b.width < a.width * 0.6 ? { right: Math.max(0, a.right - b.left), bottom: 0 } : { right: 0, bottom: Math.max(0, a.bottom - b.top) }
}

export function useCamera(
  mapRef: RefObject<maplibregl.Map | null>,
  container: RefObject<HTMLDivElement | null>,
  { ready, pos, selection, caps, route }: { ready: boolean; pos: Map<string, LngLat>; selection: Selection; caps: Capabilities; route: { key: string; points: LngLat[] } | null },
): { fit: (duration?: number) => void } {
  const fit = useCallback(
    (duration = 600) => {
      const map = mapRef.current
      if (!map || pos.size === 0) return
      const b = new maplibregl.LngLatBounds()
      pos.forEach((p) => b.extend(p))
      const c = covered(container.current)
      map.fitBounds(b, { padding: { top: 60, left: 60, right: 60 + c.right, bottom: 60 + c.bottom }, maxZoom: 12, duration })
    },
    [mapRef, container, pos],
  )

  // Start at "fit to data" once the first positions arrive, unless the view
  // already moved away from the configured start (e.g. the viewer panned).
  const autoFitted = useRef(false)
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || autoFitted.current || pos.size === 0) return
    autoFitted.current = true
    const c = map.getCenter()
    const untouched = Math.abs(c.lng - caps.map.lon) < 1e-6 && Math.abs(c.lat - caps.map.lat) < 1e-6 && Math.abs(map.getZoom() - caps.map.zoom) < 1e-6
    if (untouched) fit(0)
  }, [ready, pos, fit, mapRef, caps])

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
      mapRef.current?.easeTo({ center: p, zoom: Math.max(mapRef.current.getZoom(), 10), duration: 600, offset: [-c.right / 2, -c.bottom / 2] })
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
    map.fitBounds(b, { padding: { top: 80, left: 80, right: 80 + c.right, bottom: 80 + c.bottom }, maxZoom: 13, duration: 600 })
  }, [route, mapRef, container])

  return { fit }
}
