import { useEffect, useMemo, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MapboxOverlay } from '@deck.gl/mapbox'
import type { Layer, PickingInfo } from '@deck.gl/core'
import type { Capabilities } from '../api/types'
import type { Edge, SnapshotView } from '../derive/views'
import { useStore } from '../state/store'
import { applyStylePaint, loadStyle, registerPMTiles } from './style'
import { bridgeRoute, positionAt, filterEdges, linkGeometry, placeNodes, visibleLinks, type LinkGeom, type PlacedNode } from './model'
import { frameArrived, onPingAdded, pingCount } from './pings'
import { BASEMAP_GROUPS } from './layers'
import { meshLayerBuilder, type ReachGeom, type RouteGeom } from './meshLayers'
import { buildPingLayers } from './pingLayers'
import { useCamera } from './camera'
import { clusterLabels, type Cluster, type LabelDatum } from './labels'
import { usePacketRoute, useReach } from '../state/data'
import { installTestHook } from './testHook'
import { useTheme, type Theme } from '../theme'
import { PALETTES } from './palette'
import { useRegions } from './regions'

/** Mainland Norway, Lindesnes to Nordkapp and Utsira to Grense Jakobselv. */
const NORWAY_BOUNDS: [[number, number], [number, number]] = [[4.5, 57.9], [31.2, 71.25]]
/** Where most of Norway (and its mesh) lies, east to west. */
const NORWAY_FOCUS_LON = 13.5
/** The start view's centre longitude: the focus, clamped so both ends of the country stay in view. */
export function startLon(width: number, zoom: number): number {
  const p = startPadding(width)
  const degPerPx = 360 / (512 * 2 ** zoom)
  const [[west], [east]] = NORWAY_BOUNDS
  const lo = east - (width / 2 - p.right) * degPerPx // further west and Finnmark leaves the view
  const hi = west + (width / 2 - p.left) * degPerPx // further east and the west coast does
  return lo > hi ? (west + east) / 2 : Math.min(Math.max(NORWAY_FOCUS_LON, lo), hi)
}
/** Room around the country; on the right, for the floating tool rail. */
const startPadding = (width = window.innerWidth) => {
  const narrow = width <= 560
  // Below the floating header (D-082).
  const head = document.getElementById('topbar')?.offsetHeight ?? 50
  return { top: head + 24, bottom: 16, left: 16, right: narrow ? 64 : 92 }
}



interface Props {
  caps: Capabilities
  snapshot: SnapshotView | undefined
  onPositions: (pos: Map<string, [number, number]>) => void
}

export default function MapView({ caps, snapshot, onPositions }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const overlayRef = useRef<MapboxOverlay | null>(null)
  const pingOverlayRef = useRef<MapboxOverlay | null>(null)
  const meshLayers = useRef<Layer[] | null>(null) // read by the e2e hook
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null)
  const coords = useRef<HTMLDivElement>(null) // written directly: a re-render per mousemove is too costly
  const [zoom, setZoom] = useState(caps.map.zoom)
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
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
        map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
        map.on('mousemove', (e: maplibregl.MapMouseEvent) => {
          const el = coords.current
          if (!el) return
          el.textContent = `${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}`
          el.hidden = false
        })
        const view = () => {
          setZoom(map.getZoom())
          const b = map.getBounds()
          setBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()])
        }
        map.on('moveend', view)
        map.on('load', view)
        map.on('error', (e: maplibregl.ErrorEvent) => console.warn('map error', e.error?.message))
        const overlay = new MapboxOverlay({ interleaved: true, layers: [] })
        map.addControl(overlay as unknown as maplibregl.IControl)
        // Pings animate in a canvas of their own above the map: redrawing it
        // at 30 fps leaves the basemap and the mesh layers alone (D-083).
        const pingOverlay = new MapboxOverlay({ interleaved: false, layers: [], getCursor: () => 'inherit' })
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
    }
  }, [caps]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const windowEnd = snapshot ? Date.parse(snapshot.meta.window.end) : Date.now()
  const windowMs = snapshot ? Date.parse(snapshot.meta.window.end) - Date.parse(snapshot.meta.window.start) : 1

  const { placed, pos, links } = useMemo(() => {
    const nodes = snapshot?.nodes ?? []
    const { placed: all } = placeNodes(nodes, windowEnd, windowMs)
    const placed = filters.positionedOnly ? all.filter((p) => p.kind === 'reported') : all
    // Positions of the markers actually drawn: links, pings and the camera use only these.
    const pos = new Map<string, [number, number]>()
    for (const p of placed) pos.set(p.node.id, [p.lon, p.lat])
    const edges = filterEdges(snapshot?.edges ?? [], filters, toggles)
    const roles = new Map(nodes.map((n) => [n.id, n.identity?.role]))
    const links = linkGeometry(edges, pos, roles).filter((g) => (g.mqtt ? toggles.mqttLinks : g.infra ? toggles.infraLinks : toggles.otherLinks))
    return { placed, pos, links }
  }, [snapshot, filters, toggles.infraLinks, toggles.otherLinks, toggles.mqttLinks, toggles.inferred, windowEnd, windowMs]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onPositions(pos), [pos, onPositions])

  const selectedNode = selection?.kind === 'node' ? selection.id : null
  // A packet's route replaces every link while it is drawn.
  const routeLp = useStore((s) => s.route)
  const routeQ = usePacketRoute(routeLp)
  // Moved nodes are drawn where they were when the packet was heard, with a
  // ring there and a dashed line to where they are now (D-073).
  const nodeById = useMemo(() => new Map((snapshot?.nodes ?? []).map((n) => [n.id, n])), [snapshot])
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
  const shownLinks = useMemo(() => (route || reach ? [] : visibleLinks(links, { selectedNode, zoom, bounds })), [route, reach, links, selectedNode, zoom, bounds])

  // Name clusters at this zoom. One fans out while hovered (with a short
  // grace period to reach its names) or while one of its nodes is selected.
  // Only while names are drawn (from zoom 10, with the layer on): clustering
  // reruns on every zoom change and otherwise only feeds hover churn.
  const namesShown = toggles.labels && zoom >= 10
  const clusters = useMemo(() => (namesShown ? clusterLabels(placed, zoom) : []), [namesShown, placed, zoom])
  const clusterOf = useRef(new Map<string, Cluster>())
  const nameOf = useRef(new Map<string, string>())
  const shortOf = useRef(new Map<string, string>())
  ;[nameOf.current, shortOf.current] = useMemo(() => {
    const nodes = snapshot?.nodes ?? []
    return [
      new Map(nodes.map((n) => [n.id, n.identity?.long_name || n.identity?.short_name || n.id])),
      new Map(nodes.map((n) => [n.id, n.identity?.short_name || n.identity?.long_name || n.id])),
    ]
  }, [snapshot])
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
  const baseLayers = useMemo(
    () => buildMeshLayers({ placed, links: shownLinks, selection, search, toggles, zoom, clusters, exploded, route, routeGhosts, palette, regions, reach }),
    [buildMeshLayers, placed, shownLinks, selection, search, toggles, zoom, clusters, exploded, route, routeGhosts, palette, regions, reach],
  )

  // The mesh layers change only with data, filters and selection.
  useEffect(() => {
    if (!ready || !overlayRef.current) return
    overlayRef.current.setProps({ layers: baseLayers })
    meshLayers.current = baseLayers
  }, [ready, baseLayers])

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
          const why = { direct: 'heard directly', traceroute: 'traceroute hop', relay: 'relayed hop', gap: 'nodes in between unknown', unknown_relay: 'relayed by an unknown node' }[g.why]
          return setHover({ x: info.x, y: info.y, text: `${nm(g.a)} → ${nm(g.b)}: ${why}` })
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
          const sn = (id: string) => shortOf.current.get(id) ?? id
          const dir = (e: Edge | undefined, from: string, to: string) => `${sn(from)} → ${sn(to)}: ${e ? `${e.confidence}, ${e.samples} samples${e.zero_cost?.likely ? ', 0-cost' : ''}` : 'no evidence'}`
          setHover({ x: info.x, y: info.y, text: [o.mqtt ? 'Over the internet (MQTT), not radio' : '', dir(o.ab, o.a, o.b), dir(o.ba, o.b, o.a)].filter(Boolean).join('\n') })
        }
      },
      onClick: (info: PickingInfo) => {
        const o = info.object as PlacedNode | LinkGeom | LabelDatum | RouteGeom | undefined
        if (!o) return select(null) // empty map: clear the selection
        if ('seg' in o) return
        if ('label' in o) select({ kind: 'node', id: o.node.node.id })
        else if ('kind' in o) select({ kind: 'node', id: o.node.id })
        else select({ kind: 'edge', src: o.a, dst: o.b, mqtt: o.mqtt })
      },
    })
  }, [ready, select])

  const routeFrame = useMemo(() => (routeLp && route?.length ? { key: routeLp, points: route.flatMap((r) => [r.from, r.to]) } : null), [routeLp, route])
  const { fit } = useCamera(mapRef, container, { pos, selection, route: routeFrame })

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
      {hover && (
        <div className="tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }} role="tooltip">
          {hover.text}
        </div>
      )}
    </div>
  )
}
