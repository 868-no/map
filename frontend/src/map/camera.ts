// Camera behaviour: fit to data (on request), fly to a selected node,
// and keep framed content clear of the panel that overlays the map.
import { useCallback, useEffect, useRef, type RefObject } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { PlaceMark, Selection } from '../state/store'
import { MARKER_CLUSTER_MAX_ZOOM } from './markerClusters'

type LngLat = [number, number]

/** Frames a fly-to waits for the panel that a selection opens (about 0.2 s). */
const PANEL_WAIT_FRAMES = 12

/** Pixels of the map covered by the floating header (top), the open panel
 * (right edge; on phones the bottom, above the rail) and the rail when it lies
 * along the bottom edge (phones). */
function covered(container: HTMLElement | null): { top: number; right: number; bottom: number } {
  if (!container) return { top: 0, right: 0, bottom: 0 }
  const a = container.getBoundingClientRect()
  const head = document.getElementById('topbar')
  const top = head ? Math.max(0, head.getBoundingClientRect().bottom - a.top) : 0
  // On phones the rail is a bar along the bottom (D-132).
  const rail = document.querySelector('.rail')?.getBoundingClientRect()
  const railBottom = rail && rail.width > rail.height ? Math.max(0, a.bottom - rail.top) : 0
  const panel = document.getElementById('dock')
  if (!panel || panel.hidden) return { top, right: 0, bottom: railBottom }
  const b = panel.getBoundingClientRect()
  // The side panel is narrow. On phones it spans the width, sitting on the
  // rail and growing upwards: frame content above it, unless it leaves too little map.
  if (b.width < a.width * 0.6) return { top, right: Math.max(0, a.right - b.left), bottom: railBottom }
  const below = Math.max(0, a.bottom - b.top)
  return { top, right: 0, bottom: a.height - below - top >= 160 ? Math.max(railBottom, below) : railBottom }
}

export function useCamera(
  mapRef: RefObject<maplibregl.Map | null>,
  container: RefObject<HTMLDivElement | null>,
  // ready: the map has loaded. The effects below run again then, as the data
  // can arrive before the map exists (mapRef is not reactive).
  { pos, selection, route, place, ready }: { pos: Map<string, LngLat>; selection: Selection; route: { key: string; points: LngLat[] } | null; place: PlaceMark | null; ready: boolean },
): { fit: (duration?: number) => void; zoomTo: (points: LngLat[]) => void } {
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

  // Zoom in to a marker cluster's members (D-204): far enough that they
  // come apart, at least to the zoom where markers stop clustering.
  const zoomTo = useCallback(
    (points: LngLat[]) => {
      const map = mapRef.current
      if (!map || points.length === 0) return
      const b = new maplibregl.LngLatBounds()
      points.forEach((p) => b.extend(p))
      const c = covered(container.current)
      const cam = map.cameraForBounds(b, { padding: { top: 40 + c.top, left: 60, right: 60 + c.right, bottom: 60 + c.bottom }, maxZoom: 13 })
      if (!cam) return
      map.easeTo({ center: cam.center, zoom: Math.max(cam.zoom ?? 0, MARKER_CLUSTER_MAX_ZOOM, map.getZoom()), duration: 600 })
    },
    [mapRef, container],
  )

  // Fly to a selected node once per selection, centred in the area the side
  // panel leaves free. Positions refresh as live data arrives; that must not
  // pull the view back.
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
    // Not cancelled by a position refresh; skipped if the selection changed
    // meanwhile. Selecting opens the panel through a state update that renders
    // a frame or two later: wait for it (briefly, as a selection need not open
    // it), so the first flight already leaves room for it.
    let frames = 0
    const go = () => {
      if (flownTo.current !== id) return
      const panel = document.getElementById('dock')
      if ((!panel || panel.hidden) && frames++ < PANEL_WAIT_FRAMES) return void requestAnimationFrame(go)
      const c = covered(container.current)
      mapRef.current?.easeTo({ center: p, zoom: Math.max(mapRef.current.getZoom(), 10), duration: 600, offset: [-c.right / 2, (c.top - c.bottom) / 2] })
    }
    requestAnimationFrame(go)
  }, [selection, pos, mapRef, container, ready])

  // Follow the selected node when it moves (D-210): pan by its move on
  // screen, so it stays where it was in view, wherever the user put it. Not
  // while the view is moving (a drag, the first flight): then on its end.
  const followed = useRef<{ id: string; p: LngLat } | null>(null)
  useEffect(() => {
    const map = mapRef.current
    const id = selection?.kind === 'node' ? selection.id : null
    const p = id ? pos.get(id) : undefined
    if (!map || !id || !p) {
      if (followed.current?.id !== id) followed.current = null
      return
    }
    const was = followed.current
    if (was?.id !== id) {
      followed.current = { id, p } // the flight above frames it
      return
    }
    if (was.p[0] === p[0] && was.p[1] === p[1]) return
    const from = was.p
    const follow = () => {
      if (followed.current !== was || was.p !== from) return // moved on meanwhile
      const a = map.project(from)
      const b = map.project(p)
      was.p = p
      map.panBy([b.x - a.x, b.y - a.y], { duration: 600 })
    }
    if (!map.isMoving()) return follow()
    map.once('moveend', follow)
    return () => void map.off('moveend', follow)
  }, [selection, pos, mapRef, ready])

  // Go to a place picked from the search (D-193), in the area the panel leaves free.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !place) return
    const c = covered(container.current)
    map.easeTo({ center: [place.lon, place.lat], zoom: place.zoom, duration: 800, offset: [-c.right / 2, (c.top - c.bottom) / 2] })
  }, [place, mapRef, container, ready])

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
  }, [route, mapRef, container, ready])

  return { fit, zoomTo }
}
