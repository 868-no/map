// The static mesh layers: accuracy circles, links, nodes and node names.
// Rebuilt when data, filters, selection, search or zoom change; pings
// animate on top. Each layer's data array is memoised on its real inputs,
// so deck.gl regenerates attributes only for layers whose data changed;
// selection, search and theme only recolour, through updateTriggers.
import { IconLayer, LineLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import type { PathStyleExtensionProps } from '@deck.gl/extensions'
import type { Layer } from '@deck.gl/core'
import type { Selection, Toggles } from '../state/store'
import { ageColor, CONFIDENCE_ALPHA, glyphInk, LINK_WIDTH, MQTT_ARROW, mqttFlow, type MqttFlow, OPT_OUT_RING, ROUTE_COLOR, precisionErrorM, roleRadius, type LinkGeom, type PlacedNode } from './model'
import { dashExt, UNDER_LABELS, type RGBA } from './deckShared'
import { labelData, type Cluster } from './labels'
import type { RouteSegment } from '../derive/views'
import type { MapPalette } from './palette'

export interface MeshLayerInput {
  placed: PlacedNode[]
  links: LinkGeom[] // already filtered for level of detail / selection
  selection: Selection
  search: string
  toggles: Toggles
  zoom: number
  clusters: Cluster[] // label clusters at this zoom
  exploded: Set<string> // cluster ids shown fanned out
  route?: RouteGeom[] | null // a packet's route, drawn instead of links
  palette: MapPalette // colours for the current theme
}

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
const FLOWS = Object.keys(MQTT_ARROW) as MqttFlow[]
const ICON_MAPPING = Object.fromEntries(FLOWS.map((f, k) => [f, { x: k * ICON_PX, y: 0, width: ICON_PX, height: ICON_PX, mask: true }]))
const FONT_SETTINGS = { sdf: true, fontSize: 64, buffer: 16, radius: 16 }
let arrowAtlas: HTMLCanvasElement | undefined
function arrowIcons() {
  if (!arrowAtlas) {
    arrowAtlas = document.createElement('canvas')
    arrowAtlas.width = ICON_PX * FLOWS.length
    arrowAtlas.height = ICON_PX
    const g = arrowAtlas.getContext('2d')!
    g.fillStyle = '#fff'
    FLOWS.forEach((f, k) => {
      g.setTransform(ICON_PX / 24, 0, 0, ICON_PX / 24, k * ICON_PX, 0)
      g.fill(new Path2D(MQTT_ARROW[f]))
    })
  }
  // Image props accept a canvas at runtime (converted to a texture); the typings list only string | Texture.
  return { iconAtlas: arrowAtlas as unknown as string, iconMapping: ICON_MAPPING }
}

/** Remembers the last result; recomputes only when an argument changes identity. */
export function memoLast<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
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
type Glyph = { p: PlacedNode; flow: MqttFlow }

/**
 * A mesh layer builder with its own memo of data arrays. Keep one per map
 * (data arrays must keep their identity between calls).
 */
export function meshLayerBuilder(): (input: MeshLayerInput) => Layer[] {
  // Accuracy circles: estimate uncertainty for all estimated nodes when
  // switched on; for the selected node always, including the precision
  // cell of a coarse reported position.
  const circlesOf = memoLast((placed: PlacedNode[], all: boolean, selId: string | null) => {
    const out: Circle[] = []
    for (const p of placed) {
      const selected = p.node.id === selId
      if (p.kind === 'estimated' && (all || selected)) out.push({ pos: [p.lon, p.lat], r: p.radiusM ?? 2000, est: true })
      else if (selected && p.node.position?.precision_known) {
        const r = precisionErrorM(p.node.position.precision_bits ?? 32, p.lat)
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
  const routeParts = memoLast((route: RouteGeom[]) => ({ solid: route.filter((r) => !r.dashed), dashed: route.filter((r) => r.dashed) }))
  const glyphsOf = memoLast((placed: PlacedNode[]) =>
    placed.flatMap((p): Glyph[] => {
      const flow = mqttFlow(p.node)
      return flow ? [{ p, flow }] : []
    }),
  )
  const optOutOf = memoLast((placed: PlacedNode[]) => placed.filter((p) => p.node.mqtt_opt_out))
  const labelsOf = memoLast(labelData)

  return ({ placed, links, selection: sel, search, toggles, zoom, clusters, exploded, route, palette: c }) => {
    const q = search.trim().toLowerCase()
    const matches = (p: PlacedNode) =>
      !q || p.node.id.includes(q) || (p.node.identity?.long_name ?? '').toLowerCase().includes(q) || (p.node.identity?.short_name ?? '').toLowerCase().includes(q)
    const selId = sel?.kind === 'node' ? sel.id : null
    // Stable string keys for updateTriggers: a node selection does not recolour links, nor a link selection nodes.
    const selLink = sel?.kind === 'edge' ? `${sel.src}|${sel.dst}|${!!sel.mqtt}` : ''
    const isSelLink = (g: LinkGeom) => sel?.kind === 'edge' && !!sel.mqtt === g.mqtt && ((sel.src === g.a && sel.dst === g.b) || (sel.src === g.b && sel.dst === g.a))
    const linkColor = (g: LinkGeom) => (isSelLink(g) ? c.selected : [...(g.infra ? c.linkInfra : c.linkOther), CONFIDENCE_ALPHA[g.confidence] ?? 150]) as RGBA
    const layers: Layer[] = []

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
      )
    }

    layers.push(
      new ScatterplotLayer<PlacedNode>({
        id: 'nodes', ...UNDER_LABELS, data: placed, getPosition: (p) => [p.lon, p.lat],
        // Size by role, fill by last heard (scaled to the window); estimated
        // nodes are hollow rings in the same colour.
        radiusUnits: 'pixels', getRadius: (p) => roleRadius(p.node.identity?.role),
        filled: true, stroked: true, lineWidthUnits: 'pixels',
        getFillColor: (p) => (p.kind === 'estimated' ? [0, 0, 0, 0] : matches(p) ? [...ageColor(p.age), 255] : c.dimmed) as RGBA,
        getLineColor: (p) =>
          (p.node.id === selId ? c.selected
            : p.kind === 'estimated' ? (matches(p) ? [...ageColor(p.age), 255] : c.dimmed)
            : p.node.is_gateway ? [...c.gateway, 255] : c.nodeOutline) as RGBA,
        getLineWidth: (p) => (p.node.id === selId ? 3 : p.kind === 'estimated' || p.node.is_gateway ? 2 : 1),
        pickable: true, autoHighlight: true, highlightColor: [...c.gateway, 160],
        updateTriggers: { getFillColor: [q, c], getLineColor: [selId, q, c], getLineWidth: [selId] },
      }),
    )

    // MQTT direction inside the marker: ↑ uplinks (gateway), ↓ probably
    // downlinks (traceroutes reach it at exactly 0 dB), ↕ both (D-054).
    const glyphs = glyphsOf(placed)
    if (glyphs.length) {
      layers.push(
        new IconLayer<Glyph>({
          id: 'mqtt-glyphs', ...UNDER_LABELS, data: glyphs, getPosition: ({ p }) => [p.lon, p.lat],
          ...arrowIcons(), getIcon: ({ flow }) => flow, sizeUnits: 'pixels', getSize: ({ p }) => roleRadius(p.node.identity?.role) * 1.5,
          // On the fill when there is one; hollow estimate rings get the ring's colour.
          getColor: ({ p }) => (!matches(p) ? c.dimmed : p.kind === 'estimated' ? [...ageColor(p.age), 255] : [...glyphInk(ageColor(p.age)), 255]) as RGBA,
          pickable: false,
          updateTriggers: { getColor: [q, c] },
        }),
      )
    }

    // Nodes that did not allow MQTT uplink (their packets reached us through
    // another gateway): always ringed in red, never named (D-032).
    const optOut = optOutOf(placed)
    if (optOut.length) {
      layers.push(
        new ScatterplotLayer<PlacedNode>({
          id: 'mqtt-opt-out', ...UNDER_LABELS, data: optOut, getPosition: (p) => [p.lon, p.lat],
          radiusUnits: 'pixels', getRadius: (p) => roleRadius(p.node.identity?.role) + 4,
          filled: false, stroked: true, lineWidthUnits: 'pixels', getLineWidth: 2, getLineColor: OPT_OUT_RING, pickable: false,
        }),
      )
    }

    if (toggles.labels && zoom >= 10) {
      // Names that would overlap are clustered; hovered or selected clusters fan out.
      const { labels, leaders } = labelsOf(clusters, exploded, zoom)
      if (leaders.length) {
        layers.push(
          new LineLayer<(typeof leaders)[number]>({
            id: 'label-leaders', ...UNDER_LABELS, data: leaders, getSourcePosition: (l) => l.from, getTargetPosition: (l) => l.to,
            widthUnits: 'pixels', getWidth: 1, getColor: c.leader, pickable: false,
          }),
        )
      }
      layers.push(
        new TextLayer<(typeof labels)[number]>({
          id: 'node-labels', ...UNDER_LABELS, data: labels, getPosition: (l) => l.pos,
          getText: (l) => l.text, getSize: 18,
          // Collapsed names sit above their marker; fanned-out names centre on their slot.
          getPixelOffset: (l) => (l.exploded ? [0, 0] : [0, -(roleRadius(l.node.node.identity?.role) + 12)]),
          getColor: (l) => (l.node.node.id === selId ? c.selected : [...(l.node.kind === 'estimated' ? c.textEstimated : c.text), 235] as RGBA),
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
