// The static mesh layers: accuracy circles, links, nodes and node names.
// Rebuilt when data, filters, selection or zoom change; pings animate on top.
import { IconLayer, LineLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import type { PathStyleExtensionProps } from '@deck.gl/extensions'
import type { Layer } from '@deck.gl/core'
import type { Selection, Toggles } from '../state/store'
import { ageColor, CONFIDENCE_ALPHA, glyphInk, LINK_WIDTH, MQTT_ARROW, mqttFlow, type MqttFlow, OPT_OUT_RING, ROUTE_COLOR, precisionErrorM, roleRadius, type LinkGeom, type PlacedNode } from './model'
import { dashExt, UNDER_LABELS, type RGBA } from './deckShared'
import { labelData, type Cluster, type LabelDatum } from './labels'
import type { RouteSegment } from '../api/views'
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
// connect-src does not allow for data: URLs.
const ICON_PX = 64
const FLOWS = Object.keys(MQTT_ARROW) as MqttFlow[]
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
  const mapping = Object.fromEntries(FLOWS.map((f, k) => [f, { x: k * ICON_PX, y: 0, width: ICON_PX, height: ICON_PX, mask: true }]))
  // Image props accept a canvas at runtime (converted to a texture); the typings list only string | Texture.
  return { iconAtlas: arrowAtlas as unknown as string, iconMapping: mapping }
}

export function buildMeshLayers({ placed, links, selection: sel, search, toggles, zoom, clusters, exploded, route, palette: c }: MeshLayerInput): Layer[] {
  const q = search.trim().toLowerCase()
  const matches = (p: PlacedNode) =>
    !q || p.node.id.includes(q) || (p.node.identity?.long_name ?? '').toLowerCase().includes(q) || (p.node.identity?.short_name ?? '').toLowerCase().includes(q)
  const isSel = (id: string) => sel?.kind === 'node' && sel.id === id
  const isSelLink = (g: LinkGeom) => sel?.kind === 'edge' && !!sel.mqtt === g.mqtt && ((sel.src === g.a && sel.dst === g.b) || (sel.src === g.b && sel.dst === g.a))
  const linkColor = (g: LinkGeom) => (isSelLink(g) ? c.selected : [...(g.infra ? c.linkInfra : c.linkOther), CONFIDENCE_ALPHA[g.confidence] ?? 150]) as RGBA
  const layers: Layer[] = []

  // Accuracy circles: estimate uncertainty for all estimated nodes when
  // switched on; for the selected node always, including the precision
  // cell of a coarse reported position.
  const circles: { pos: [number, number]; r: number; est: boolean }[] = []
  for (const p of placed) {
    const selected = isSel(p.node.id)
    if (p.kind === 'estimated' && (toggles.uncertainty || selected)) circles.push({ pos: [p.lon, p.lat], r: p.radiusM ?? 2000, est: true })
    else if (selected && p.node.position?.precision_known) {
      const r = precisionErrorM(p.node.position.precision_bits ?? 32, p.lat)
      if (r > 0) circles.push({ pos: [p.lon, p.lat], r, est: false })
    }
  }
  if (circles.length) {
    layers.push(
      new ScatterplotLayer<(typeof circles)[number]>({
        id: 'uncertainty', ...UNDER_LABELS, data: circles, getPosition: (c) => c.pos, getRadius: (c) => c.r, radiusUnits: 'meters',
        filled: true, stroked: true, lineWidthMinPixels: 1, pickable: false,
        getFillColor: (e) => [...(e.est ? c.estimate : c.precision), e.est ? 22 : 18] as RGBA,
        getLineColor: (e) => [...(e.est ? c.estimate : c.precision), e.est ? 140 : 120] as RGBA,
        updateTriggers: { getFillColor: [c], getLineColor: [c] },
      }),
    )
  }

  // Hops that went over MQTT (D-055): their own dotted layer, beneath the radio links.
  const mqttLinks = links.filter((g) => g.mqtt)
  if (mqttLinks.length) {
    layers.push(
      new PathLayer<LinkGeom, PathStyleExtensionProps<LinkGeom>>({
        id: 'links-mqtt', ...UNDER_LABELS, data: mqttLinks, getPath: (g) => g.path, widthUnits: 'pixels', getWidth: 2.5,
        getColor: (g) => (isSelLink(g) ? c.selected : [...c.linkMqtt, 220]) as RGBA, getDashArray: [1, 2.5], dashJustified: true, extensions: [dashExt],
        pickable: true, autoHighlight: true, highlightColor: c.highlight,
        updateTriggers: { getColor: [sel, c] },
      }),
    )
  }

  // Two radio link layers per class: other links first (thin, beneath), then
  // infrastructure links (router <-> router, thicker) on top.
  for (const cls of ['other', 'infra'] as const) {
    const data = links.filter((g) => !g.mqtt && g.infra === (cls === 'infra'))
    layers.push(
      new LineLayer<LinkGeom>({
        id: `links-${cls}`, ...UNDER_LABELS, data: data.filter((g) => !g.inferred),
        getSourcePosition: (g) => g.path[0], getTargetPosition: (g) => g.path[1], widthUnits: 'pixels', getWidth: LINK_WIDTH[cls],
        getColor: linkColor, pickable: true, autoHighlight: true, highlightColor: c.highlight,
        updateTriggers: { getColor: [sel, c] },
      }),
      new PathLayer<LinkGeom, PathStyleExtensionProps<LinkGeom>>({
        id: `links-${cls}-inferred`, ...UNDER_LABELS, data: data.filter((g) => g.inferred), getPath: (g) => g.path, widthUnits: 'pixels', getWidth: LINK_WIDTH[cls],
        getColor: linkColor, getDashArray: [4, 3], dashJustified: true, extensions: [dashExt],
        pickable: true, autoHighlight: true, highlightColor: c.highlight,
        updateTriggers: { getColor: [sel, c] },
      }),
    )
  }

  if (route) {
    // Solid where both nodes of a hop are known; dashed across missing nodes.
    layers.push(
      new LineLayer<RouteGeom>({
        id: 'route', ...UNDER_LABELS, data: route.filter((r) => !r.dashed), getSourcePosition: (r) => r.from, getTargetPosition: (r) => r.to,
        widthUnits: 'pixels', getWidth: 3, getColor: ROUTE_COLOR, pickable: true,
      }),
      new PathLayer<RouteGeom, PathStyleExtensionProps<RouteGeom>>({
        id: 'route-gaps', ...UNDER_LABELS, data: route.filter((r) => r.dashed), getPath: (r) => [r.from, r.to], widthUnits: 'pixels', getWidth: 3,
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
        (isSel(p.node.id) ? c.selected
          : p.kind === 'estimated' ? (matches(p) ? [...ageColor(p.age), 255] : c.dimmed)
          : p.node.is_gateway ? [...c.gateway, 255] : c.nodeOutline) as RGBA,
      getLineWidth: (p) => (isSel(p.node.id) ? 3 : p.kind === 'estimated' || p.node.is_gateway ? 2 : 1),
      pickable: true, autoHighlight: true, highlightColor: [...c.gateway, 160],
      updateTriggers: { getFillColor: [q, c], getLineColor: [sel, q, c], getLineWidth: [sel] },
    }),
  )

  // MQTT direction inside the marker: ↑ uplinks (gateway), ↓ probably
  // downlinks (traceroutes reach it at exactly 0 dB), ↕ both (D-054).
  const mqtt = placed.flatMap((p) => {
    const flow = mqttFlow(p.node)
    return flow ? [{ p, flow }] : []
  })
  if (mqtt.length) {
    layers.push(
      new IconLayer<(typeof mqtt)[number]>({
        id: 'mqtt-glyphs', ...UNDER_LABELS, data: mqtt, getPosition: ({ p }) => [p.lon, p.lat],
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
  const optOut = placed.filter((p) => p.node.mqtt_opt_out)
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
    const { labels, leaders } = labelData(clusters, exploded, zoom)
    if (leaders.length) {
      layers.push(
        new LineLayer<(typeof leaders)[number]>({
          id: 'label-leaders', ...UNDER_LABELS, data: leaders, getSourcePosition: (l) => l.from, getTargetPosition: (l) => l.to,
          widthUnits: 'pixels', getWidth: 1, getColor: c.leader, pickable: false,
        }),
      )
    }
    layers.push(
      new TextLayer<LabelDatum>({
        id: 'node-labels', ...UNDER_LABELS, data: labels, getPosition: (l) => l.pos,
        getText: (l) => l.text, getSize: 18,
        // Collapsed names sit above their marker; fanned-out names centre on their slot.
        getPixelOffset: (l) => (l.exploded ? [0, 0] : [0, -(roleRadius(l.node.node.identity?.role) + 12)]),
        getColor: (l) => (isSel(l.node.node.id) ? c.selected : [...(l.node.kind === 'estimated' ? c.textEstimated : c.text), 235] as RGBA),
        // 'auto' builds the glyph atlas from the names (Æ, Ø, Å, emoji); the default is ASCII only.
        characterSet: 'auto', fontFamily: 'system-ui, sans-serif', fontWeight: 600,
        outlineWidth: 3, outlineColor: c.textOutline, fontSettings: { sdf: true, fontSize: 64, buffer: 16, radius: 16 },
        // Pickable so hovering a name opens its cluster and clicking a fanned-out name selects it.
        pickable: true,
        updateTriggers: { getColor: [sel, c] },
      }),
    )
  }
  return layers
}
