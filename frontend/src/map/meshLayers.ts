// The static mesh layers: regions (when on), accuracy circles, links, nodes
// and node names.
// Rebuilt when data, filters, selection, search or zoom change; pings
// animate on top. Each layer's data array is memoised on its real inputs,
// so deck.gl regenerates attributes only for layers whose data changed;
// selection, search and theme only recolour, through updateTriggers.
import { IconLayer, LineLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import type { PathStyleExtensionProps } from '@deck.gl/extensions'
import type { Layer } from '@deck.gl/core'
import type { Selection, Toggles } from '../state/store'
import { ageColor, CONFIDENCE_ALPHA, glyphInk, matchesSearch, LINK_WIDTH, MQTT_ARROW, mqttDownlink, mqttUplink, PLANE, type MqttFlow, OPT_OUT_RING, ROUTE_COLOR, TRACE_COLOR, precisionErrorM, type LinkGeom, type PlacedNode } from './model'
import { dashExt, dashOffsetExt, UNDER_LABELS, type RGBA } from './deckShared'
import { labelData, type Cluster } from './labels'
import { drawOrder, OVER_MARKERS, type DrawOrderProps } from './drawOrder'
import { mercY } from './pings'
import type { RouteSegment } from '../derive/views'
import type { MapPalette } from './palette'
import { regionLayers, type RegionCollection } from './regions'
import { GLYPH_PX, GLYPH_STROKE, GLYPH_UNITS, NODE_RADIUS, ROLE_GLYPHS, roleIcon, UPLINK_BADGE, type RoleIcon } from './roleIcons'

export interface MeshLayerInput {
  placed: PlacedNode[]
  links: LinkGeom[] // already filtered for level of detail / selection
  selection: Selection
  search: string
  toggles: Pick<Toggles, 'uncertainty' | 'trails' | 'labels'> // only those it reads, so others rebuild nothing
  zoom: number
  clusters: Cluster[] // label clusters at this zoom
  exploded: Set<string> // cluster ids shown fanned out
  route?: RouteGeom[] | null // a packet's route, drawn instead of links
  routeGhosts?: { then: [number, number]; now: [number, number] }[] // moved nodes on the route: where they were, and are (D-073)
  palette: MapPalette // colours for the current theme
  regions?: RegionCollection | null // landsdeler, drawn beneath everything else
  reach?: ReachGeom | null // the selected node's simulated reach, drawn instead of links (D-069)
}

/** Reach paths up to the chosen hop limit, and the nodes they reach. */
export interface ReachGeom {
  segments: { from: [number, number]; to: [number, number]; need: number; free: boolean; gap: boolean }[] // gap: across relays without a position
  reached: Set<string> // ids, the originator included
}

/** A 0-cost direction on a drawn link: a chevron near the end that relays for free. */
type Chevron = { pos: [number, number]; angle: number }

export interface RouteGeom {
  from: [number, number]
  to: [number, number]
  dashed: boolean // nodes between the two ends are missing
  seg: RouteSegment
}

// The arrows as one mask atlas (white shapes, tinted per node by getColor),
// drawn once on a canvas: deck.gl would fetch icon URLs, which the CSP's
// connect-src does not allow for data: URLs. The mapping is a constant so
// getIcon is not invalidated on every rebuild.
const ICON_PX = 64
// Inside each marker its role glyph (D-186); on the rim, a gateway's uplink
// badge (a disc with the uplink arrow, D-084); beside it the downlink arrow
// (bottom right) and the airplane (top left, D-073).
type Badge = 'plane' | 'down'
type GlyphIcon = RoleIcon | 'disc' | MqttFlow | 'plane'
const ICON_PATHS: Record<MqttFlow | 'plane', string> = { ...MQTT_ARROW, plane: PLANE }
const ICONS: GlyphIcon[] = ['router', 'routerLate', 'base', 'client', 'disc', ...(Object.keys(ICON_PATHS) as (MqttFlow | 'plane')[])]
const ICON_MAPPING = Object.fromEntries(ICONS.map((f, k) => [f, { x: k * ICON_PX, y: 0, width: ICON_PX, height: ICON_PX, mask: true }]))
const FONT_SETTINGS = { sdf: true, fontSize: 64, buffer: 16, radius: 16 }
// A right-pointing chevron, rotated per link toward its free end (D-068).
const CHEVRON_MAPPING = { chevron: { x: 0, y: 0, width: ICON_PX, height: ICON_PX, mask: true } }
let chevronAtlas: HTMLCanvasElement | undefined
function chevronIcon() {
  if (!chevronAtlas) {
    chevronAtlas = document.createElement('canvas')
    chevronAtlas.width = chevronAtlas.height = ICON_PX
    const g = chevronAtlas.getContext('2d')
    if (!g) return { iconAtlas: chevronAtlas as unknown as string, iconMapping: CHEVRON_MAPPING } // no canvas (tests)
    g.strokeStyle = '#fff'
    g.lineWidth = ICON_PX * 0.16
    g.lineCap = g.lineJoin = 'round'
    g.beginPath()
    g.moveTo(ICON_PX * 0.32, ICON_PX * 0.18)
    g.lineTo(ICON_PX * 0.68, ICON_PX * 0.5)
    g.lineTo(ICON_PX * 0.32, ICON_PX * 0.82)
    g.stroke()
  }
  return { iconAtlas: chevronAtlas as unknown as string, iconMapping: CHEVRON_MAPPING }
}
/** Chevron 65 % of the way from transmitter to the receiver that relays it for free. */
function chevron(from: [number, number], to: [number, number]): Chevron {
  const f = 0.65
  const angle = (Math.atan2(mercY(to[1]) - mercY(from[1]), ((to[0] - from[0]) * Math.PI) / 180) * 180) / Math.PI
  return { pos: [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f], angle }
}
/** A traceroute leg's offset from the line between its nodes, in line widths (right of its direction). */
const LEG_OFFSET = 0.8
/** The same offset in pixels for a chevron at `angle` (degrees, counter-clockwise from east). */
function legShift(angle: number): [number, number] {
  const a = (angle * Math.PI) / 180, d = LEG_OFFSET * 3
  return [Math.sin(a) * d, Math.cos(a) * d] // right of the direction, screen y pointing down
}
let arrowAtlas: HTMLCanvasElement | undefined
function arrowIcons() {
  if (!arrowAtlas) {
    arrowAtlas = document.createElement('canvas')
    arrowAtlas.width = ICON_PX * ICONS.length
    arrowAtlas.height = ICON_PX
    const g = arrowAtlas.getContext('2d')
    if (!g) return { iconAtlas: arrowAtlas as unknown as string, iconMapping: ICON_MAPPING } // no canvas (tests)
    g.fillStyle = g.strokeStyle = '#fff'
    ICONS.forEach((f, k) => {
      if (f === 'disc') {
        g.setTransform(1, 0, 0, 1, k * ICON_PX, 0)
        g.beginPath()
        g.arc(ICON_PX / 2, ICON_PX / 2, ICON_PX / 2, 0, 2 * Math.PI)
        g.fill()
      } else if (f in ROLE_GLYPHS) {
        // A role glyph fills its cell as the marker disc does: 16 units across, centred.
        const glyph = ROLE_GLYPHS[f as RoleIcon], u = ICON_PX / GLYPH_UNITS
        g.setTransform(u, 0, 0, u, k * ICON_PX + ICON_PX / 2, ICON_PX / 2)
        g.lineWidth = GLYPH_STROKE
        g.lineCap = 'round'
        if (glyph.stroke) g.stroke(new Path2D(glyph.stroke))
        if (glyph.fill) g.fill(new Path2D(glyph.fill))
        if (glyph.cut) {
          g.globalCompositeOperation = 'destination-out'
          g.fill(new Path2D(glyph.cut))
          g.globalCompositeOperation = 'source-over'
        }
      } else {
        g.setTransform(ICON_PX / 24, 0, 0, ICON_PX / 24, k * ICON_PX, 0)
        g.fill(new Path2D(ICON_PATHS[f as MqttFlow | 'plane']))
      }
    })
  }
  // Image props accept a canvas at runtime (converted to a texture); the typings list only string | Texture.
  return { iconAtlas: arrowAtlas as unknown as string, iconMapping: ICON_MAPPING }
}

/** Remembers the last result; recomputes only when an argument changes identity. */
function memoLast<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  let last: A | undefined
  let out: R
  return (...a: A) => {
    if (!last || a.some((x, k) => x !== last![k])) {
      last = a
      out = fn(...a)
    }
    return out
  }
}

type Circle = { pos: [number, number]; r: number; est: boolean }
/**
 * One icon drawn for a node; `part` says which: its role glyph, the uplink
 * badge's rim, disc and arrow, or a badge beside it. `k` is the node's place
 * in the draw order.
 */
type Glyph = { p: PlacedNode; k: number; icon: GlyphIcon; part: 'role' | 'rim' | 'badge' | 'uplink' | Badge }
/** A node's glyphs, bottom to top: its role, its uplink badge if a gateway, and the downlink and airplane badges (see MqttFlow). */
const glyphsFor = (p: PlacedNode, k: number): Glyph[] => {
  const up = mqttUplink(p.node)
  return [
    { p, k, icon: roleIcon(p.node.identity?.role), part: 'role' },
    ...(up ? [{ p, k, icon: 'disc' as const, part: 'rim' as const }, { p, k, icon: 'disc' as const, part: 'badge' as const }, { p, k, icon: up, part: 'uplink' as const }] : []),
    ...(mqttDownlink(p.node) ? [{ p, k, icon: 'down' as const, part: 'down' as const }] : []),
    ...(p.node.airborne ? [{ p, k, icon: 'plane' as const, part: 'plane' as const }] : []),
  ]
}
/** Glyph sizes in pixels: the role glyph covers the disc; the uplink badge sits on the rim (D-186). */
const BADGE_R = UPLINK_BADGE.r * GLYPH_PX
const GLYPH_SIZE: Record<Glyph['part'], number> = {
  role: NODE_RADIUS * 2, rim: (BADGE_R + UPLINK_BADGE.rim * GLYPH_PX) * 2, badge: BADGE_R * 2, uplink: BADGE_R * 1.35, plane: 15, down: 10,
}
const BADGE_AT: [number, number] = [UPLINK_BADGE.x * GLYPH_PX, UPLINK_BADGE.y * GLYPH_PX]
const GLYPH_OFFSET: Record<Glyph['part'], [number, number]> = {
  role: [0, 0], rim: BADGE_AT, badge: BADGE_AT, uplink: BADGE_AT, plane: [-(NODE_RADIUS + 3), -(NODE_RADIUS + 3)], down: [NODE_RADIUS + 3, NODE_RADIUS + 2],
}
/** Places kept per trail before the marker: enough to show which way it goes. */
const TRAIL_POINTS = 3
type Trail = { id: string; from: [number, number]; to: [number, number]; alpha: number }

/**
 * A mesh layer builder with its own memo of data arrays. Keep one per map
 * (data arrays must keep their identity between calls).
 */
export function meshLayerBuilder(): (input: MeshLayerInput) => Layer[] {
  // Accuracy circles: estimate uncertainty for all estimated nodes when
  // switched on and nothing is selected; with a node selected, only its own,
  // always, including the precision cell of a coarse reported position.
  const circlesOf = memoLast((placed: PlacedNode[], all: boolean, selId: string | null) => {
    const out: Circle[] = []
    for (const p of placed) {
      const selected = p.node.id === selId
      // With a node selected, only its circle; otherwise every estimate's when switched on.
      if (p.kind === 'estimated' && (selected || (all && !selId))) out.push({ pos: [p.lon, p.lat], r: p.radiusM ?? 2000, est: true })
      else if (selected && (p.node.refined || p.node.position?.precision_known)) {
        const r = p.node.refined?.radius_m ?? precisionErrorM(p.node.position!.precision_bits ?? 32, p.lat)
        if (r > 0) out.push({ pos: [p.lon, p.lat], r, est: false })
      }
    }
    return out
  })
  const linkClasses = memoLast((links: LinkGeom[]) => {
    const out = { mqtt: [] as LinkGeom[], other: [] as LinkGeom[], 'other-inferred': [] as LinkGeom[], infra: [] as LinkGeom[], 'infra-inferred': [] as LinkGeom[] }
    for (const g of links) {
      if (g.mqtt) out.mqtt.push(g)
      else out[`${g.infra ? 'infra' : 'other'}${g.inferred ? '-inferred' : ''}`].push(g)
    }
    return out
  })
  const routeParts = memoLast((all: RouteGeom[]) => {
    // A traceroute's legs are drawn apart, in colours of their own.
    const route = all.filter((r) => !r.seg.leg)
    const net = (r: RouteGeom) => r.seg.why === 'internet'
    const ack = (r: RouteGeom) => r.seg.why === 'delivered'
    const radio = (r: RouteGeom) => !net(r) && !ack(r)
    return { solid: route.filter((r) => !r.dashed && radio(r)), dashed: route.filter((r) => r.dashed && radio(r)), internet: route.filter(net), delivered: route.filter(ack), legs: all.filter((r) => !!r.seg.leg) }
  })
  const reachParts = memoLast((segs: ReachGeom['segments']) => ({ solid: segs.filter((r) => !r.gap), gaps: segs.filter((r) => r.gap), free: segs.filter((r) => r.free) }))
  // Draw order: plain clients first, then home stations, then routers, so
  // where markers overlap the infrastructure is on top (stable otherwise).
  const RANK: Record<RoleIcon, number> = { client: 0, base: 1, routerLate: 2, router: 2 }
  const byRank = memoLast((placed: PlacedNode[]) => [...placed].sort((a, b) => RANK[roleIcon(a.node.identity?.role)] - RANK[roleIcon(b.node.identity?.role)]))
  // Every node's glyphs, in draw order: a glyph is above its own disc and
  // below the discs of nodes drawn after it, by depth (D-187).
  const glyphsOf = memoLast((ordered: PlacedNode[]) => ordered.flatMap((p, k) => glyphsFor(p, k)))
  const optOutOf = memoLast((placed: PlacedNode[]) => placed.filter((p) => p.node.mqtt_opt_out))
  const hollowOf = memoLast((placed: PlacedNode[]) => placed.filter((p) => p.kind === 'estimated'))
  // Trails behind moving nodes (D-073): segments between consecutive
  // positions, fading towards the oldest, ending at the marker.
  // With a node selected, only its trail.
  const trailsOf = memoLast((placed: PlacedNode[], only: string | null) => {
    const segs: Trail[] = []
    for (const p of placed) {
      if (only && p.node.id !== only) continue
      const t = p.node.track
      if (!t || t.length < 2) continue
      // A direction, not the whole history: the last few places before the marker.
      const pts: [number, number][] = [...t.slice(-TRAIL_POINTS).map((x) => [x.lon, x.lat] as [number, number]), [p.lon, p.lat]]
      for (let k = 1; k < pts.length; k++) {
        if (pts[k][0] === pts[k - 1][0] && pts[k][1] === pts[k - 1][1]) continue
        segs.push({ id: p.node.id, from: pts[k - 1], to: pts[k], alpha: Math.round(50 + (190 * k) / (pts.length - 1)) })
      }
    }
    return { segs, chevrons: segs.map((s) => ({ ...chevron(s.from, s.to), alpha: s.alpha })) }
  })
  const chevronsOf = memoLast((links: LinkGeom[]) =>
    links.flatMap((g): Chevron[] => {
      if (g.mqtt) return []
      const [p0, p1] = [g.path[0], g.path[g.path.length - 1]]
      const out: Chevron[] = []
      if (g.ab?.zero_cost?.likely) out.push(chevron(g.ab.src === g.a ? p0 : p1, g.ab.src === g.a ? p1 : p0))
      if (g.ba?.zero_cost?.likely) out.push(chevron(g.ba.src === g.a ? p0 : p1, g.ba.src === g.a ? p1 : p0))
      return out
    }),
  )
  const labelsOf = memoLast(labelData)

  return ({ placed, links, selection: sel, search, toggles, zoom, clusters, exploded, route, routeGhosts, palette: c, regions, reach }) => {
    const q = search.trim().toLowerCase()
    // Search and reach both dim the nodes they leave out.
    const matches = (p: PlacedNode) =>
      (!reach || reach.reached.has(p.node.id)) &&
      matchesSearch(p.node, q)
    const selId = sel?.kind === 'node' ? sel.id : null
    // Stable string keys for updateTriggers: a node selection does not recolour links, nor a link selection nodes.
    const selLink = sel?.kind === 'edge' ? `${sel.src}|${sel.dst}|${!!sel.mqtt}` : ''
    const isSelLink = (g: LinkGeom) => sel?.kind === 'edge' && !!sel.mqtt === g.mqtt && ((sel.src === g.a && sel.dst === g.b) || (sel.src === g.b && sel.dst === g.a))
    const linkColor = (g: LinkGeom) => (isSelLink(g) ? c.selected : [...(g.infra ? c.linkInfra : c.linkOther), CONFIDENCE_ALPHA[g.confidence] ?? 150]) as RGBA
    const layers: Layer[] = regions ? regionLayers(regions, zoom, c) : []

    const circles = circlesOf(placed, toggles.uncertainty, selId)
    if (circles.length) {
      layers.push(
        new ScatterplotLayer<Circle>({
          id: 'uncertainty', ...UNDER_LABELS, data: circles, getPosition: (e) => e.pos, getRadius: (e) => e.r, radiusUnits: 'meters',
          filled: true, stroked: true, lineWidthMinPixels: 1, pickable: false,
          getFillColor: (e) => [...(e.est ? c.estimate : c.precision), e.est ? 22 : 18] as RGBA,
          getLineColor: (e) => [...(e.est ? c.estimate : c.precision), e.est ? 140 : 120] as RGBA,
          updateTriggers: { getFillColor: [c], getLineColor: [c] },
        }),
      )
    }

    // Hops that went over MQTT (D-055): their own dotted layer, beneath the radio links.
    const cls = linkClasses(links)
    if (cls.mqtt.length) {
      layers.push(
        new PathLayer<LinkGeom, PathStyleExtensionProps<LinkGeom>>({
          id: 'links-mqtt', ...UNDER_LABELS, data: cls.mqtt, getPath: (g) => g.path, widthUnits: 'pixels', getWidth: 2.5,
          getColor: (g) => (isSelLink(g) ? c.selected : [...c.linkMqtt, 220]) as RGBA, getDashArray: [1, 2.5], dashJustified: true, extensions: [dashExt],
          pickable: true, autoHighlight: true, highlightColor: c.highlight,
          updateTriggers: { getColor: [selLink, c] },
        }),
      )
    }

    // Two radio link layers per class: other links first (thin, beneath), then
    // infrastructure links (router <-> router, thicker) on top.
    for (const k of ['other', 'infra'] as const) {
      layers.push(
        new LineLayer<LinkGeom>({
          id: `links-${k}`, ...UNDER_LABELS, data: cls[k],
          getSourcePosition: (g) => g.path[0], getTargetPosition: (g) => g.path[1], widthUnits: 'pixels', getWidth: LINK_WIDTH[k],
          getColor: linkColor, pickable: true, autoHighlight: true, highlightColor: c.highlight,
          updateTriggers: { getColor: [selLink, c] },
        }),
        new PathLayer<LinkGeom, PathStyleExtensionProps<LinkGeom>>({
          id: `links-${k}-inferred`, ...UNDER_LABELS, data: cls[`${k}-inferred`], getPath: (g) => g.path, widthUnits: 'pixels', getWidth: LINK_WIDTH[k],
          getColor: linkColor, getDashArray: [4, 3], dashJustified: true, extensions: [dashExt],
          pickable: true, autoHighlight: true, highlightColor: c.highlight,
          updateTriggers: { getColor: [selLink, c] },
        }),
      )
    }

    // Where moving nodes have been, and which way they went (D-073).
    if (toggles.trails) {
      const trails = trailsOf(placed, selId)
      if (trails.segs.length) {
        layers.push(
          new LineLayer<Trail>({
            id: 'trails', ...UNDER_LABELS, data: trails.segs, getSourcePosition: (s) => s.from, getTargetPosition: (s) => s.to,
            widthUnits: 'pixels', getWidth: 2, getColor: (s) => [...c.trail, s.alpha] as RGBA, pickable: false,
            updateTriggers: { getColor: [c] },
          }),
          new IconLayer<Chevron & { alpha: number }>({
            id: 'trail-arrows', ...UNDER_LABELS, data: trails.chevrons, getPosition: (h) => h.pos, getAngle: (h) => h.angle,
            ...chevronIcon(), getIcon: () => 'chevron', sizeUnits: 'pixels', getSize: 12, getColor: (h) => [...c.trail, h.alpha] as RGBA,
            pickable: false, updateTriggers: { getColor: [c] },
          }),
        )
      }
    }

    // 0-cost directions on the drawn radio links (D-068).
    const chevrons = chevronsOf(links)
    if (chevrons.length) {
      layers.push(
        new IconLayer<Chevron>({
          id: 'zero-cost', ...UNDER_LABELS, data: chevrons, getPosition: (h) => h.pos, getAngle: (h) => h.angle,
          ...chevronIcon(), getIcon: () => 'chevron', sizeUnits: 'pixels', getSize: 17, getColor: [...c.zeroCost, 255],
          pickable: false, updateTriggers: { getColor: [c] },
        }),
      )
    }

    // The selected node's reach (D-069), instead of links: each reached node
    // from the transmitter it hears, coloured by the hop limit that reaches it.
    if (reach) {
      const ramp = (n: number) => [...c.reach[Math.min(n, c.reach.length - 1)], 230] as RGBA
      const parts = reachParts(reach.segments)
      layers.push(
        new LineLayer<ReachGeom['segments'][number]>({
          id: 'reach', ...UNDER_LABELS, data: parts.solid, getSourcePosition: (r) => r.from, getTargetPosition: (r) => r.to,
          widthUnits: 'pixels', getWidth: 2.5, getColor: (r) => ramp(r.need), pickable: false,
          updateTriggers: { getColor: [c] },
        }),
        new PathLayer<ReachGeom['segments'][number], PathStyleExtensionProps<ReachGeom['segments'][number]>>({
          id: 'reach-gaps', ...UNDER_LABELS, data: parts.gaps, getPath: (r) => [r.from, r.to], widthUnits: 'pixels', getWidth: 2.5,
          getColor: (r) => ramp(r.need), getDashArray: [4, 3], dashJustified: true, extensions: [dashExt], pickable: false,
          updateTriggers: { getColor: [c] },
        }),
        new IconLayer<ReachGeom['segments'][number]>({
          id: 'reach-free', ...UNDER_LABELS, data: parts.free, getPosition: (r) => chevron(r.from, r.to).pos,
          getAngle: (r) => chevron(r.from, r.to).angle, ...chevronIcon(), getIcon: () => 'chevron', sizeUnits: 'pixels', getSize: 14,
          getColor: [...c.zeroCost, 255], pickable: false, updateTriggers: { getColor: [c] },
        }),
      )
    }

    if (route) {
      // Solid where both nodes of a hop are known; dashed across missing nodes.
      const parts = routeParts(route)
      layers.push(
        new LineLayer<RouteGeom>({
          id: 'route', ...UNDER_LABELS, data: parts.solid, getSourcePosition: (r) => r.from, getTargetPosition: (r) => r.to,
          widthUnits: 'pixels', getWidth: 3, getColor: ROUTE_COLOR, pickable: true,
        }),
        new PathLayer<RouteGeom, PathStyleExtensionProps<RouteGeom>>({
          id: 'route-gaps', ...UNDER_LABELS, data: parts.dashed, getPath: (r) => [r.from, r.to], widthUnits: 'pixels', getWidth: 3,
          getColor: ROUTE_COLOR, getDashArray: [5, 4], dashJustified: true, extensions: [dashExt], pickable: true,
        }),
        // Hops over the internet (an MQTT downlink, D-087): dotted green, like internet links.
        new PathLayer<RouteGeom, PathStyleExtensionProps<RouteGeom>>({
          id: 'route-internet', ...UNDER_LABELS, data: parts.internet, getPath: (r) => [r.from, r.to], widthUnits: 'pixels', getWidth: 3,
          getColor: [...c.linkMqtt, 230], getDashArray: [1, 2.5], dashJustified: true, extensions: [dashExt], pickable: true,
          updateTriggers: { getColor: [c] },
        }),
        // Confirmed by an ACK (D-096): the receiver got it, by a path not drawn.
        new PathLayer<RouteGeom, PathStyleExtensionProps<RouteGeom>>({
          id: 'route-delivered', ...UNDER_LABELS, data: parts.delivered, getPath: (r) => [r.from, r.to], widthUnits: 'pixels', getWidth: 3,
          getColor: [...c.delivered, 230], getDashArray: [6, 3], dashJustified: true, extensions: [dashExt], pickable: true,
          updateTriggers: { getColor: [c] },
        }),
        // A traceroute both ways: the way there and the way back each in a
        // colour of its own, beside the line between two nodes (each to the
        // right of its own direction), so a hop taken both ways shows both.
        // Dashed across missing nodes, dotted over the internet.
        new PathLayer<RouteGeom, PathStyleExtensionProps<RouteGeom>>({
          id: 'route-legs', ...UNDER_LABELS, data: parts.legs, getPath: (r) => [r.from, r.to], widthUnits: 'pixels', getWidth: 3,
          getColor: (r) => TRACE_COLOR[r.seg.leg!], getOffset: LEG_OFFSET, getDashArray: (r) => (r.seg.why === 'internet' ? [1, 2.5] : r.dashed ? [5, 4] : [0, 0]),
          dashJustified: true, extensions: [dashOffsetExt], pickable: true,
        }),
        // Which way each hop went: transmitter to receiver.
        new IconLayer<RouteGeom>({
          id: 'route-arrows', ...UNDER_LABELS, data: route, getPosition: (r) => chevron(r.from, r.to).pos,
          getAngle: (r) => chevron(r.from, r.to).angle, ...chevronIcon(), getIcon: () => 'chevron', sizeUnits: 'pixels', getSize: 13,
          getPixelOffset: (r) => (r.seg.leg ? legShift(chevron(r.from, r.to).angle) : [0, 0]),
          getColor: (r) => (r.seg.leg ? TRACE_COLOR[r.seg.leg] : r.seg.why === 'internet' ? [...c.linkMqtt, 255] : r.seg.why === 'delivered' ? [...c.delivered, 255] : ROUTE_COLOR) as RGBA, pickable: false, updateTriggers: { getColor: [c] },
        }),
      )
    }

    // Moved nodes on a drawn route: a ring where they were when the packet
    // was heard, dashed to their marker now (D-073).
    if (route && routeGhosts?.length) {
      layers.push(
        new PathLayer<{ then: [number, number]; now: [number, number] }, PathStyleExtensionProps<{ then: [number, number]; now: [number, number] }>>({
          id: 'route-moved-path', ...UNDER_LABELS, data: routeGhosts, getPath: (g) => [g.then, g.now], widthUnits: 'pixels', getWidth: 1.5,
          getColor: [...c.trail, 170], getDashArray: [2, 3], dashJustified: true, extensions: [dashExt], pickable: false,
          updateTriggers: { getColor: [c] },
        }),
        new ScatterplotLayer<{ then: [number, number]; now: [number, number] }>({
          id: 'route-moved', ...UNDER_LABELS, data: routeGhosts, getPosition: (g) => g.then, radiusUnits: 'pixels', getRadius: 7,
          filled: false, stroked: true, lineWidthUnits: 'pixels', getLineWidth: 2, getLineColor: [...c.trail, 230], pickable: false,
          updateTriggers: { getLineColor: [c] },
        }),
      )
    }

    // Estimated nodes are hollow rings: a dark halo either side keeps the
    // ring visible on any basemap (it vanishes into the dark one, harmlessly).
    const hollow = hollowOf(placed)
    if (hollow.length) {
      layers.push(
        new ScatterplotLayer<PlacedNode>({
          id: 'nodes-halo', ...UNDER_LABELS, data: hollow, getPosition: (p) => [p.lon, p.lat],
          radiusUnits: 'pixels', getRadius: NODE_RADIUS,
          filled: false, stroked: true, lineWidthUnits: 'pixels', getLineWidth: 4,
          getLineColor: c.nodeOutline, pickable: false,
          updateTriggers: { getLineColor: [c] },
        }),
      )
    }
    // One disc for every role (its glyph says the role), filled by last heard
    // (scaled to the window); estimated nodes are hollow rings in the same colour.
    const marker = {
      ...UNDER_LABELS, getPosition: (p: PlacedNode) => [p.lon, p.lat] as [number, number],
      // The node's place in the draw order: index in `ordered`, kept with its glyphs.
      extensions: [drawOrder], getDrawOrder: (_p: PlacedNode, { index }: { index: number }) => index * 2,
      radiusUnits: 'pixels' as const, getRadius: NODE_RADIUS,
      filled: true, stroked: true, lineWidthUnits: 'pixels' as const,
      getFillColor: (p: PlacedNode) => (p.kind === 'estimated' ? [0, 0, 0, 0] : matches(p) ? [...ageColor(p.age, c.ageStops), 255] : c.dimmed) as RGBA,
      getLineColor: (p: PlacedNode) =>
        (p.node.id === selId ? c.selected
          : p.kind === 'estimated' ? (matches(p) ? [...ageColor(p.age, c.ageStops), 255] : c.dimmed)
          : p.node.is_gateway ? [...c.gateway, 255] : c.nodeOutline) as RGBA,
      getLineWidth: (p: PlacedNode) => (p.node.id === selId ? 3 : p.kind === 'estimated' || p.node.is_gateway ? 2 : 1),
      updateTriggers: { getFillColor: [q, c, reach], getLineColor: [selId, q, c, reach], getLineWidth: [selId] },
    }
    // Glyphs: the role inside the marker (D-186); a gateway's uplink badge on
    // the rim, ↑ uplinks or a double chevron uplinks every copy; beside it ↓
    // probably downlinks (traceroutes reach it at exactly 0 dB). D-054, D-084.
    const glyph = {
      ...UNDER_LABELS, getPosition: ({ p }: Glyph) => [p.lon, p.lat] as [number, number],
      extensions: [drawOrder], getDrawOrder: ({ k }: Glyph) => k * 2 + 1,
      getIcon: ({ icon }: Glyph) => icon, sizeUnits: 'pixels' as const,
      getSize: ({ part }: Glyph) => GLYPH_SIZE[part],
      getPixelOffset: ({ part }: Glyph) => GLYPH_OFFSET[part],
      getColor: ({ p, part }: Glyph) => {
        if (!matches(p)) return (part === 'role' ? [...c.nodeOutline.slice(0, 3), 150] : c.dimmed) as RGBA
        switch (part) {
          case 'role': // ink on the fill; hollow estimate rings get the ring's colour
            return [...(p.kind === 'estimated' ? ageColor(p.age, c.ageStops) : glyphInk(ageColor(p.age, c.ageStops))), 255] as RGBA
          case 'rim':
          case 'uplink':
            return c.nodeOutline
          case 'badge':
            return [...c.gateway, 255] as RGBA
          default:
            return [...c.trail, 255] as RGBA
        }
      },
      pickable: false,
      updateTriggers: { getColor: [q, c, reach] },
    }
    // Every marker, pickable, in one layer, then every glyph in another; the
    // depth of each says what it is drawn above (D-187).
    const ordered = byRank(placed)
    layers.push(new ScatterplotLayer<PlacedNode, DrawOrderProps<PlacedNode>>({ id: 'nodes', data: ordered, pickable: true, autoHighlight: true, highlightColor: [...c.gateway, 160], ...marker }))
    layers.push(new IconLayer<Glyph, DrawOrderProps<Glyph>>({ id: 'node-glyphs', data: glyphsOf(ordered), ...arrowIcons(), ...glyph }))

    // Nodes that did not allow MQTT uplink (their packets reached us through
    // another gateway): always ringed in red, never named (D-032).
    const optOut = optOutOf(placed)
    if (optOut.length) {
      layers.push(
        new ScatterplotLayer<PlacedNode>({
          id: 'mqtt-opt-out', ...UNDER_LABELS, ...OVER_MARKERS, data: optOut, getPosition: (p) => [p.lon, p.lat],
          radiusUnits: 'pixels', getRadius: NODE_RADIUS + 4,
          filled: false, stroked: true, lineWidthUnits: 'pixels', getLineWidth: 2, getLineColor: OPT_OUT_RING, pickable: false,
        }),
      )
    }

    if (toggles.labels && zoom >= 10) {
      // Names that would overlap are clustered; hovered or selected clusters fan out.
      const { labels, leaders } = labelsOf(clusters, exploded, zoom, selId)
      if (leaders.length) {
        layers.push(
          new LineLayer<(typeof leaders)[number]>({
            id: 'label-leaders', ...UNDER_LABELS, ...OVER_MARKERS, data: leaders, getSourcePosition: (l) => l.from, getTargetPosition: (l) => l.to,
            widthUnits: 'pixels', getWidth: 1, getColor: c.leader, pickable: false,
          }),
        )
      }
      layers.push(
        new TextLayer<(typeof labels)[number]>({
          id: 'node-labels', ...UNDER_LABELS, ...OVER_MARKERS, data: labels, getPosition: (l) => l.pos,
          getText: (l) => l.text, getSize: 18,
          // Collapsed names sit above their marker; fanned-out names centre on their slot.
          getPixelOffset: (l) => (l.exploded ? [0, 0] : [0, -(NODE_RADIUS + 12)]),
          getColor: (l) => (l.node.node.id === selId && !l.more ? c.selected : [...(l.node.kind === 'estimated' ? c.textEstimated : c.text), 235] as RGBA),
          // 'auto' builds the glyph atlas from the names (Æ, Ø, Å, emoji); the default is ASCII only.
          characterSet: 'auto', fontFamily: 'system-ui, sans-serif', fontWeight: 600,
          outlineWidth: 3, outlineColor: c.textOutline, fontSettings: FONT_SETTINGS,
          // Pickable so hovering a name opens its cluster and clicking a fanned-out name selects it.
          pickable: true,
          updateTriggers: { getColor: [selId, c] },
        }),
      )
    }
    return layers
  }
}
