import { memo, useEffect, useMemo, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MapLibreOverlay } from '@deck.gl/maplibre'
import { ScatterplotLayer } from '@deck.gl/layers'
import type { Layer, PickingInfo } from '@deck.gl/core'
import type { Capabilities } from '../api/types'
import type { Edge, MeshNode, SnapshotView } from '../derive/views'
import { useStore, type PlaceMark } from '../state/store'
import { applyStylePaint, loadStyle, registerPMTiles } from './style'
import { bridgeRoute, edgeKeysOf, namesOf, shortNamesOf, positionAt, filterEdges, passesNodeFilters, linkGeometry, placeNodes, visibleLinks, withSelectedLink, type LinkGeom, type PlacedNode } from './model'
import { frameArrived, onPingAdded, pingCount } from './pings'
import { BASEMAP_GROUPS } from './layers'
import { meshLayerBuilder, type ReachGeom, type RouteGeom } from './meshLayers'
import { buildPingLayers } from './pingLayers'
import { OVER_MARKERS } from './drawOrder'
import { useCamera } from './camera'
import { clusterLabels, type Cluster, type LabelDatum } from './labels'
import { usePacketRoute, useReach } from '../state/data'
import { installTestHook } from './testHook'
import { useTheme, type Theme } from '../theme'
import { PALETTES, type MapPalette } from './palette'
import { useRegions } from './regions'
import { create } from 'zustand'

/**
 * The hover tooltip has its own tiny store: it changes at pointer rate, and
 * held as MapView state it would re-render the whole map component (and its
 * layer memos) on every move over a marker.
 */
type Hover = { x: number; y: number; text: string } | null
const useHover = create<{ hover: Hover }>(() => ({ hover: null }))
const setHover = (hover: Hover) => useHover.setState({ hover })

function MapTooltip() {
  const hover = useHover((s) => s.hover)
  if (!hover) return null
  return (
    <div className="tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }} role="tooltip">
      {hover.text}
    </div>
  )
}

/** Mainland Norway, Lindesnes to Nordkapp and Utsira to Grense Jakobselv. */
const NORWAY_BOUNDS: [[number, number], [number, number]] = [[4.5, 57.9], [31.2, 71.25]]
/** Where most of Norway (and its mesh) lies, east to west. */
const NORWAY_FOCUS_LON = 13.5
/** The start view's centre longitude: the focus, clamped so both ends of the country stay in view. */
function startLon(width: number, zoom: number): number {
  const p = startPadding()
  const degPerPx = 360 / (512 * 2 ** zoom)
  const [[west], [east]] = NORWAY_BOUNDS
  const lo = east - (width / 2 - p.right) * degPerPx // further west and Finnmark leaves the view
  const hi = west + (width / 2 - p.left) * degPerPx // further east and the west coast does
  return lo > hi ? (west + east) / 2 : Math.min(Math.max(NORWAY_FOCUS_LON, lo), hi)
}
// The map view (centre and zoom) is remembered per browser (D-111): a
// convenience, so storage errors only mean starting afresh.
const VIEW_KEY = 'meshmap.view'
function savedView(): { center: [number, number]; zoom: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null') as { lng?: number; lat?: number; zoom?: number } | null
    if (!v || ![v.lng, v.lat, v.zoom].every((x) => typeof x === 'number' && Number.isFinite(x))) return null
    return { center: [v.lng!, Math.max(-85, Math.min(85, v.lat!))], zoom: v.zoom! }
  } catch {
    return null
  }
}
function saveView(map: maplibregl.Map) {
  try {
    const c = map.getCenter()
    localStorage.setItem(VIEW_KEY, JSON.stringify({ lng: +c.lng.toFixed(5), lat: +c.lat.toFixed(5), zoom: +map.getZoom().toFixed(2) }))
  } catch {
    /* storage unavailable: the view is not remembered */
  }
}

/** Room around the country: below the header, and clear of the tool rail
 * (on the right; along the bottom on phones, D-132). */
const startPadding = () => {
  // Below the floating header (D-082).
  const head = document.getElementById('topbar')?.offsetHeight ?? 50
  const rail = document.querySelector('.rail')?.getBoundingClientRect()
  if (rail && rail.width > rail.height) return { top: head + 24, bottom: 16 + window.innerHeight - rail.top, left: 16, right: 16 }
  return { top: head + 24, bottom: 16, left: 16, right: rail ? 16 + window.innerWidth - rail.left : 92 }
}

interface Props {
  caps: Capabilities
  snapshot: SnapshotView | undefined
  onPositions: (pos: Map<string, [number, number]>) => void
}

// Links are drawn thin (client links thinnest), so hover and click are given a
// few pixels of slop around every pickable: the clickable band is far wider
// than the line. A direct hit on a node still wins, as the centre pixel is
// tested first (D-146).
const PICK_RADIUS = 6

/** A place picked from the search (D-193): a ring where it is. */
function placeLayer(place: PlaceMark, palette: MapPalette) {
  return new ScatterplotLayer<PlaceMark>({
    id: 'place', ...OVER_MARKERS, data: [place], getPosition: (p) => [p.lon, p.lat], radiusUnits: 'pixels', getRadius: 9,
    filled: false, stroked: true, lineWidthUnits: 'pixels', getLineWidth: 3, getLineColor: palette.selected, pickable: false,
  })
}

/** The marker on the selected link where its cross section is hovered. */
function probeLayer(probe: [number, number], palette: MapPalette) {
  return new ScatterplotLayer<[number, number]>({
    id: 'terrain-probe', ...OVER_MARKERS, data: [probe], getPosition: (p) => p, radiusUnits: 'pixels', getRadius: 6,
    filled: true, getFillColor: palette.selected, stroked: true, lineWidthUnits: 'pixels', getLineWidth: 2.5,
    // An outline in the opposite tone: the marker sits on the selected link, drawn in the same colour.
    getLineColor: palette.selected[0] + palette.selected[1] + palette.selected[2] > 384 ? [14, 17, 22, 255] : [255, 255, 255, 255], pickable: false,
  })
}

/**
 * Memoised: its props change with the snapshot, while the app around it
 * re-renders on every fetch state of each live rebuild.
 */
export default memo(function MapView({ caps, snapshot, onPositions }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const startView = useRef<{ center: maplibregl.LngLat; zoom: number } | null>(null) // the view the map opened on
  const overlayRef = useRef<MapLibreOverlay | null>(null)
  const pingOverlayRef = useRef<MapLibreOverlay | null>(null)
  const meshLayers = useRef<Layer[] | null>(null) // read by the e2e hook
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const coords = useRef<HTMLDivElement>(null) // written directly: a re-render per mousemove is too costly
  const [zoom, setZoom] = useState(caps.map.zoom)
  // Mouse drag never rotates, but a two-finger twist or Shift+arrow keys do.
  const needle = useRef<SVGSVGElement>(null) // turned directly: a re-render per rotate frame is too costly
  const [bounds, setBounds] = useState<[number, number, number, number] | null>(null)
  const filters = useStore((s) => s.filters)
  const toggles = useStore((s) => s.toggles)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const search = useStore((s) => s.search)
  const theme = useTheme()
  const palette = PALETTES[theme]
  const styleFor = (t: Theme) => (t === 'light' ? caps.map.style_url_light : caps.map.style_url)
  const themeRef = useRef(theme) // the theme the map's style currently shows

  // Map + overlay lifecycle.
  useEffect(() => {
    if (!container.current) return
    let cancelled = false
    registerPMTiles()
    loadStyle(styleFor(themeRef.current), caps.map.tile_source)
      .then((style) => {
        if (cancelled || !container.current) return
        // Start with the viewer's layer choices so hidden layers never flash.
        const shown = useStore.getState().toggles.basemap
        for (const g of BASEMAP_GROUPS) {
          for (const l of style.layers) if ((g.layers as readonly string[]).includes(l.id)) l.layout = { ...(l.layout ?? {}), visibility: shown[g.id] ? 'visible' : 'none' } as never
        }
        const map = new maplibregl.Map({
          container: container.current,
          style,
          // All of Norway in view at start, clear of the tool rail (D-074).
          bounds: NORWAY_BOUNDS,
          fitBoundsOptions: { padding: startPadding() },
          // Built-in attribution renders provider HTML through MapLibre's
          // DOM.sanitize (GHSA-jrc7-96c5-q579 in <= 6.4.0); render static credit instead.
          attributionControl: false,
          maxPitch: 0,
          dragRotate: false,
        })
        // The box's centre lies over Sweden (Finnmark reaches 31°E): keep its
        // zoom, but move the view west towards the country's mass as far as
        // the whole country stays in view (D-074).
        map.jumpTo({ center: [startLon(map.getContainer().clientWidth, map.getZoom()), map.getCenter().lat] })
        // The view this browser last left the map at, if any, wins (D-111):
        // then there is no fit to the data on load.
        const saved = savedView()
        if (saved) map.jumpTo(saved)
        else startView.current = { center: map.getCenter(), zoom: map.getZoom() }
        map.on('moveend', () => saveView(map))
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
        map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
        map.on('mousemove', (e: maplibregl.MapMouseEvent) => {
          const el = coords.current
          if (!el) return
          el.textContent = `${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}`
          el.hidden = false
        })
        map.on('mouseout', () => {
          if (coords.current) coords.current.hidden = true // no stale reading once the pointer leaves
        })
        const view = () => {
          setZoom(map.getZoom())
          const b = map.getBounds()
          setBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()])
        }
        map.on('moveend', view)
        map.on('load', view)
        const turnNeedle = () => {
          if (needle.current) needle.current.style.transform = `rotate(${-map.getBearing()}deg)`
        }
        map.on('rotate', turnNeedle)
        map.on('load', turnNeedle) // a rebuilt map starts north up: so does the needle
        map.on('error', (e: maplibregl.ErrorEvent) => console.warn('map error', e.error?.message))
        const overlay = new MapLibreOverlay({ interleaved: true, pickingRadius: PICK_RADIUS, layers: [] })
        map.addControl(overlay as unknown as maplibregl.IControl)
        // Pings animate in a canvas of their own above the map: redrawing it
        // at 30 fps leaves the basemap and the mesh layers alone (D-083).
        const pingOverlay = new MapLibreOverlay({ interleaved: false, layers: [], getCursor: () => 'inherit' })
        map.addControl(pingOverlay as unknown as maplibregl.IControl)
        // As a control its canvas lands in the top-left control corner, which
        // sits below the header: move it beside the map canvas, under the controls.
        // (MapLibre appends a top-left control last in that corner.)
        const pingEl = map.getContainer().querySelector('.maplibregl-ctrl-top-left')?.lastElementChild
        if (pingEl) map.getContainer().insertBefore(pingEl, map.getContainer().querySelector('.maplibregl-control-container'))
        pingOverlayRef.current = pingOverlay
        map.on('load', () => setReady(true))
        mapRef.current = map
        overlayRef.current = overlay
        installTestHook(map, () => meshLayers.current)
      })
      .catch((e: Error) => setError(e.message))
    return () => {
      cancelled = true
      mapRef.current?.remove()
      mapRef.current = null
      overlayRef.current = null
      pingOverlayRef.current = null
      // Not ready until the new map loads: the layer and click effects then
      // run again for it, instead of staying bound to the removed one.
      setReady(false)
      setHover(null) // no tooltip left over a rebuilt map
    }
  // The map is rebuilt only when its style or tiles change, not when an equal
  // capabilities object arrives again (a refetch after a reconnect).
  }, [caps.map.style_url, caps.map.style_url_light, caps.map.tile_source]) // eslint-disable-line react-hooks/exhaustive-deps

  // Theme changes repaint the basemap in place (same layers, other colours).
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || themeRef.current === theme) return
    themeRef.current = theme
    applyStylePaint(map, styleFor(theme)).catch((e: Error) => console.warn('theme style', e.message))
  }, [ready, theme]) // eslint-disable-line react-hooks/exhaustive-deps

  // Basemap layer groups the viewer switched on or off.
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    for (const g of BASEMAP_GROUPS) {
      const vis = toggles.basemap[g.id] ? 'visible' : 'none'
      for (const id of g.layers) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis)
    }
  }, [ready, toggles.basemap])

  // 0 before data arrives: Date.now() would change on every render and re-run placement.
  const windowEnd = snapshot ? Date.parse(snapshot.meta.window.end) : 0
  const windowMs = snapshot ? Date.parse(snapshot.meta.window.end) - Date.parse(snapshot.meta.window.start) : 1

  // Placement and links apart: a link toggle or edge filter must not move
  // every marker (new positions re-run everything that follows them).
  const { positionedOnly, onlineOnly, roles: roleFilter } = filters
  const { placed, pos, allPos, roles } = useMemo(() => {
    const nodes = snapshot?.nodes ?? []
    const { placed: all } = placeNodes(nodes, windowEnd, windowMs)
    const placed = all.filter((p) => passesNodeFilters(p.node, { positionedOnly, onlineOnly, roles: roleFilter }, windowEnd))
    // Positions of the markers actually drawn: links, pings and the camera use only these.
    const pos = new Map<string, [number, number]>()
    for (const p of placed) pos.set(p.node.id, [p.lon, p.lat])
    const roles = new Map(nodes.map((n) => [n.id, n.identity?.role]))
    const allPos = new Map<string, [number, number]>(all.map((p) => [p.node.id, [p.lon, p.lat]]))
    return { placed, pos, allPos, roles }
  }, [snapshot, positionedOnly, onlineOnly, roleFilter, windowEnd, windowMs])
  const links = useMemo(() => {
    // All link layers are off by default: nothing to build (a selected link is drawn apart).
    if (!toggles.infraLinks && !toggles.otherLinks && !toggles.mqttLinks) return []
    const edges = filterEdges(snapshot?.edges ?? [], filters, toggles)
    return linkGeometry(edges, pos, roles).filter((g) => (g.mqtt ? toggles.mqttLinks : g.infra ? toggles.infraLinks : toggles.otherLinks))
  }, [snapshot, pos, roles, filters.minConfidence, filters.evidence, toggles.infraLinks, toggles.otherLinks, toggles.mqttLinks, toggles.inferred]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onPositions(pos), [pos, onPositions])

  const selectedNode = selection?.kind === 'node' ? selection.id : null
  // A packet's route replaces every link while it is drawn.
  const routeLp = useStore((s) => s.route)
  const routeQ = usePacketRoute(routeLp)
  // Moved nodes are drawn where they were when the packet was heard, with a
  // ring there and a dashed line to where they are now (D-073).
  // Only while a route is drawn.
  const nodeById = useMemo(() => (routeLp ? new Map((snapshot?.nodes ?? []).map((n) => [n.id, n])) : new Map<string, MeshNode>()), [snapshot, routeLp])
  const { route, routeGhosts } = useMemo(() => {
    if (!routeLp) return { route: null, routeGhosts: [] }
    const segs = routeQ.data?.segments ?? []
    const at = routeQ.data?.at ? Date.parse(routeQ.data.at) : NaN
    const where = new Map(pos)
    const routeGhosts: { then: [number, number]; now: [number, number] }[] = []
    for (const id of new Set(segs.flatMap((g) => [g.a, g.b]))) {
      const track = nodeById.get(id)?.track, now = pos.get(id)
      if (!track?.length || !now || Number.isNaN(at)) continue
      const then = positionAt(track, at)
      if (then[0] !== now[0] || then[1] !== now[1]) {
        where.set(id, then)
        routeGhosts.push({ then, now })
      }
    }
    return { route: bridgeRoute(segs, where), routeGhosts }
  }, [routeLp, routeQ.data, pos, nodeById])
  // The selected node's simulated reach (D-069) replaces the links too.
  const reachOpt = useStore((s) => s.reach)
  const reachQ = useReach(reachOpt ? selectedNode : null, reachOpt?.internet ?? false)
  const reach = useMemo((): ReachGeom | null => {
    if (!reachOpt || !selectedNode || !reachQ.data || reachQ.data.origin !== selectedNode) return null
    const shown = reachQ.data.nodes.filter((n) => n.need <= reachOpt.hops)
    const byId = new Map(reachQ.data.nodes.map((n) => [n.id, n]))
    return {
      reached: new Set([selectedNode, ...shown.map((n) => n.id)]),
      // Each placed node from the nearest placed transmitter up its chain:
      // relays without a position are skipped, and the line is dashed there.
      segments: shown.flatMap((n) => {
        const b = pos.get(n.id)
        if (!b) return []
        let via = n.via, gap = false
        for (let i = 0; via !== selectedNode && !pos.has(via) && i < 8; i++) {
          const up = byId.get(via)
          if (!up) break
          via = up.via
          gap = true
        }
        const a = pos.get(via)
        return a ? [{ from: a, to: b, need: n.need, free: !gap && !!n.free, gap }] : []
      }),
    }
  }, [reachOpt, selectedNode, reachQ.data, pos])
  // The link open in Details is always drawn.
  const selectedEdge = selection?.kind === 'edge' ? selection : null
  // A pan or zoom that leaves the same links drawn keeps the same array: the
  // link layers regenerate every attribute whenever their data changes.
  const lastShown = useRef<LinkGeom[]>([])
  const shownLinks = useMemo(() => {
    const next = route || reach ? [] : withSelectedLink(visibleLinks(links, { selectedNode, zoom, bounds }), selectedEdge, snapshot?.edges ?? [], allPos, roles)
    const last = lastShown.current
    if (next.length === last.length && next.every((g, i) => g === last[i])) return last
    return (lastShown.current = next)
  }, [route, reach, links, selectedNode, selectedEdge, snapshot, allPos, roles, zoom, bounds])

  // Name clusters at this zoom. One fans out while hovered (with a short
  // grace period to reach its names) or while one of its nodes is selected.
  // Only while names are drawn (from zoom 10, with the layer on): clustering
  // reruns on every zoom change and otherwise only feeds hover churn.
  const namesShown = toggles.labels && zoom >= 10
  const clusters = useMemo(() => (namesShown ? clusterLabels(placed, zoom) : []), [namesShown, placed, zoom])
  const clusterOf = useRef(new Map<string, Cluster>())
  const nameOf = useRef<ReadonlyMap<string, string>>(new Map())
  // The snapshot for the link tooltip, which builds its lookups on first use.
  const tipSnapshot = useRef(snapshot)
  tipSnapshot.current = snapshot
  nameOf.current = namesOf(snapshot?.nodes)
  clusterOf.current = useMemo(() => new Map(clusters.flatMap((c) => c.members.map((m) => [m.node.id, c] as const))), [clusters])
  const [hoverCluster, setHoverCluster] = useState<string | null>(null)
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const exploded = useMemo(() => {
    const ids = new Set<string>()
    if (hoverCluster) ids.add(hoverCluster)
    const selCluster = selectedNode ? clusterOf.current.get(selectedNode) : undefined
    if (selCluster && selCluster.members.length > 1) ids.add(selCluster.id)
    return ids
  }, [hoverCluster, selectedNode, clusters]) // eslint-disable-line react-hooks/exhaustive-deps

  // Static layers, rebuilt on data/filter/selection change; pings animate on top.
  // The builder keeps each layer's data array while its inputs are unchanged.
  const [buildMeshLayers] = useState(meshLayerBuilder)
  const regions = useRegions(toggles.regions)
  const { uncertainty, trails, labels } = toggles
  const layerToggles = useMemo(() => ({ uncertainty, trails, labels }), [uncertainty, trails, labels])
  const baseLayers = useMemo(
    () => buildMeshLayers({ placed, links: shownLinks, selection, search, toggles: layerToggles, zoom, clusters, exploded, route, routeGhosts, palette, regions, reach }),
    [buildMeshLayers, placed, shownLinks, selection, search, layerToggles, zoom, clusters, exploded, route, routeGhosts, palette, regions, reach],
  )

  // The mesh layers change only with data, filters and selection; the
  // marker where the selected link's cross section is hovered (D-143)
  // follows the store without re-rendering the map at every step.
  useEffect(() => {
    const overlay = overlayRef.current
    if (!ready || !overlay) return
    const show = (probe: [number, number] | null, place: PlaceMark | null) => {
      const layers = [...baseLayers, ...(place ? [placeLayer(place, palette)] : []), ...(probe ? [probeLayer(probe, palette)] : [])]
      overlay.setProps({ layers })
      meshLayers.current = layers // the e2e hook sees the probe too
    }
    show(useStore.getState().probe, useStore.getState().place)
    return useStore.subscribe((s, prev) => {
      if (s.probe !== prev.probe || s.place !== prev.place) show(s.probe, s.place)
    })
  }, [ready, baseLayers, palette])

  // Animation loop, in the ping canvas: runs (~30 fps) only while pings are
  // alive and starts when one is added. Idle, it only probes for a frame
  // about once a second (pings are wanted only while the page is painted).
  // Paused on hidden tabs; off with reduced motion.
  useEffect(() => {
    const overlay = pingOverlayRef.current
    if (!ready || !overlay) return
    if (!toggles.animation) {
      overlay.setProps({ layers: [] })
      return
    }
    let raf = 0, timer: ReturnType<typeof setTimeout> | undefined, last = 0, running = false
    const frame = (now: number) => {
      frameArrived(now)
      if (pingCount() === 0) {
        running = false
        overlay.setProps({ layers: [] })
        probe()
        return
      }
      raf = requestAnimationFrame(frame)
      if (document.hidden || now - last < 33) return
      last = now
      overlay.setProps({ layers: buildPingLayers(now, mapRef.current?.getZoom() ?? 8, palette) })
    }
    const start = () => {
      if (running) return
      running = true
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(frame)
    }
    const probe = () => {
      timer = setTimeout(() => {
        raf = requestAnimationFrame((now) => {
          frameArrived(now)
          if (pingCount() > 0) start()
          else probe()
        })
      }, 1000)
    }
    const off = onPingAdded(start)
    start()
    return () => {
      off()
      clearTimeout(timer)
      cancelAnimationFrame(raf)
    }
  }, [ready, toggles.animation, palette])

  // Picking: hover tooltip + click selection.
  useEffect(() => {
    overlayRef.current?.setProps({
      getCursor: ({ isHovering }) => (isHovering ? 'pointer' : 'grab'),
      onHover: (info: PickingInfo) => {
        const o = info.object as PlacedNode | LinkGeom | LabelDatum | RouteGeom | undefined
        // Open the hovered node's or name's cluster; close it shortly after leaving.
        const c = !o || 'seg' in o ? undefined : 'label' in o ? o.cluster : 'kind' in o ? clusterOf.current.get(o.node.id) : undefined
        clearTimeout(collapseTimer.current)
        if (c && c.members.length > 1) setHoverCluster(c.id)
        else collapseTimer.current = setTimeout(() => setHoverCluster(null), 400)
        if (!o) return setHover(null)
        if ('seg' in o) {
          const g = (o as RouteGeom).seg
          const nm = (id: string) => nameOf.current.get(id) ?? id
          const why = { direct: 'heard directly', traceroute: 'traceroute hop', relay: 'relayed hop', gap: 'path to here not known (direct, or through relays that spent no hop)', unknown_relay: 'relayed by an unknown node', internet: 'over the internet: taken from an MQTT broker, not heard over the air', delivered: 'delivery confirmed: it sent an ACK for this packet (the path may not be known)' }[g.why]
          const leg = g.leg === 'forward' ? 'Traceroute, the way there (request)\n' : g.leg === 'back' ? 'Traceroute, the way back (reply)\n' : ''
          return setHover({ x: info.x, y: info.y, text: `${leg}${nm(g.a)} → ${nm(g.b)}: ${why}` })
        }
        if ('label' in o) {
          const n = o.node.node
          setHover({ x: info.x, y: info.y, text: o.exploded || o.cluster.members.length === 1 ? n.identity?.long_name ?? n.id : `${o.cluster.members.length} nodes close together` })
        } else if ('kind' in o) {
          if (c && c.members.length > 1) return setHover(null) // its names are fanned out: a tooltip would cover them
          const n = o.node
          const name = n.identity?.long_name ?? n.id
          setHover({ x: info.x, y: info.y, text: `${name}${o.kind === 'estimated' ? ' — estimated location' : ''}${n.airborne ? ' — airborne' : n.moved_at ? ' — moving' : ''}${n.mqtt_opt_out ? ' — did not allow MQTT uplink; name withheld' : ''}` })
        } else {
          // One line per direction, nodes by short name.
          const short = shortNamesOf(tipSnapshot.current?.nodes)
          // Every edge, before the map's filters: a direction a filter hid is not "no evidence".
          const all = edgeKeysOf(tipSnapshot.current?.edges)
          const sn = (id: string) => short.get(id) ?? id
          const hidden = (from: string, to: string) => all.has(`${from}|${to}|${!!o.mqtt}`)
          const dir = (e: Edge | undefined, from: string, to: string) =>
            `${sn(from)} → ${sn(to)}: ${e ? (e.mqtt ? 'over the internet' : `${e.confidence} confidence, ${e.samples} report${e.samples === 1 ? '' : 's'}${e.zero_cost?.likely ? ', 0-cost' : ''}`) : hidden(from, to) ? 'hidden by the filters' : 'no evidence'}`
          setHover({ x: info.x, y: info.y, text: [o.mqtt ? 'Over the internet (MQTT), not radio' : '', dir(o.ab, o.a, o.b), dir(o.ba, o.b, o.a)].filter(Boolean).join('\n') })
        }
      },
    })
    // Clicks come from MapLibre, then deck.gl picks what lies there. deck.gl's
    // own click is a tap that must end within 250 ms of when the page handled
    // its start: a frame that takes longer in between (a slow phone, or a
    // software renderer drawing pings) turns it into a press, and the click is
    // lost. MapLibre's click has no time limit, only a movement one.
    const map = mapRef.current
    if (!ready || !map) return
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const info = overlayRef.current?.pickObject({ x: e.point.x, y: e.point.y, radius: PICK_RADIUS })
      const o = info?.object as PlacedNode | LinkGeom | LabelDatum | RouteGeom | undefined
      if (!o) return select(null) // empty map: clear the selection
      if ('seg' in o) return
      if ('label' in o) select({ kind: 'node', id: o.node.node.id })
      else if ('kind' in o) select({ kind: 'node', id: o.node.id })
      else select({ kind: 'edge', src: o.a, dst: o.b, mqtt: o.mqtt })
    }
    map.on('click', onClick)
    return () => void map.off('click', onClick)
  }, [ready, select])

  const routeFrame = useMemo(() => (routeLp && route?.length ? { key: routeLp, points: route.flatMap((r) => [r.from, r.to]) } : null), [routeLp, route])
  const place = useStore((s) => s.place)
  const { fit } = useCamera(mapRef, container, { pos, selection, route: routeFrame, place, ready })
  // On page load, fit the map to the data once its markers are placed (D-074):
  // the Norway view only bridges the wait. A permanent link to a node flies
  // there instead, so it is left alone.
  // Nor is a view someone already moved away from while the data loaded, or
  // a view restored from the last visit (no start view then).
  const fittedOnLoad = useRef(false)
  useEffect(() => {
    const map = mapRef.current
    if (fittedOnLoad.current || pos.size === 0 || !map) return
    fittedOnLoad.current = true
    const s = startView.current
    const unmoved = !!s && Math.abs(map.getZoom() - s.zoom) < 0.01 && map.getCenter().distanceTo(s.center) < 100
    if (!selection && unmoved) fit(1200) // a smooth zoom from Norway to the mesh
  }, [ready, pos, selection, fit]) // ready: the data can arrive before the map exists

  return (
    <div className="map-wrap">
      <div ref={container} className="map" role="region" aria-label="Mesh map" />
      {error && <div className="banner error">Map unavailable: {error}. Is the basemap built (scripts/basemap_import.sh)?</div>}
      <div className="fit-ctrl maplibregl-ctrl maplibregl-ctrl-group">
        <button type="button" onClick={() => fit()} disabled={pos.size === 0} aria-label="Fit to data" title="Fit map to nodes with positions">
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" />
          </svg>
        </button>
        <button type="button" onClick={() => mapRef.current?.resetNorth({ duration: 400 })} aria-label="Reset north" title="Turn the map so north is up">
          {/* The needle points north wherever the map is turned. */}
          <svg ref={needle} viewBox="0 0 20 20" width="18" height="18" aria-hidden>
            <path d="M10 1.5 14.5 10h-9z" fill="var(--err)" />
            <path d="M10 18.5 5.5 10h9z" fill="currentColor" opacity="0.7" />
          </svg>
        </button>
      </div>
      <div ref={coords} className="coords" aria-hidden hidden />
      <div className="attribution">
        <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a>{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
        {toggles.regions && (
          <>
            {' '}
            <a href="https://www.kartverket.no/" target="_blank" rel="noreferrer">© Kartverket</a>
          </>
        )}
      </div>
      <MapTooltip />
    </div>
  )
})
