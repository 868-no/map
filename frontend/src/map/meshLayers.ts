// The static mesh layers: accuracy circles, links, nodes and node names.
// Rebuilt when data, filters, selection or zoom change; pings animate on top.
import { LineLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import type { PathStyleExtensionProps } from '@deck.gl/extensions'
import type { Layer } from '@deck.gl/core'
import type { Selection, Toggles } from '../state/store'
import { ageColor, CONFIDENCE_ALPHA, LINK_COLOR, LINK_WIDTH, OPT_OUT_RING, ROUTE_COLOR, precisionErrorM, roleRadius, type LinkGeom, type PlacedNode } from './model'
import { dashExt, UNDER_LABELS, type RGBA } from './deckShared'
import { labelData, type Cluster, type LabelDatum } from './labels'
import type { RouteSegment } from '../derive/route'

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
}

export interface RouteGeom {
  from: [number, number]
  to: [number, number]
  dashed: boolean // nodes between the two ends are missing
  seg: RouteSegment
}

export function buildMeshLayers({ placed, links, selection: sel, search, toggles, zoom, clusters, exploded, route }: MeshLayerInput): Layer[] {
  const q = search.trim().toLowerCase()
  const matches = (p: PlacedNode) =>
    !q || p.node.id.includes(q) || (p.node.identity?.long_name ?? '').toLowerCase().includes(q) || (p.node.identity?.short_name ?? '').toLowerCase().includes(q)
  const isSel = (id: string) => sel?.kind === 'node' && sel.id === id
  const isSelLink = (g: LinkGeom) => sel?.kind === 'edge' && ((sel.src === g.a && sel.dst === g.b) || (sel.src === g.b && sel.dst === g.a))
  const linkColor = (g: LinkGeom) => (isSelLink(g) ? [255, 255, 255, 255] : [...LINK_COLOR[g.infra ? 'infra' : 'other'], CONFIDENCE_ALPHA[g.confidence] ?? 150]) as RGBA
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
        getFillColor: (c) => (c.est ? [176, 156, 255, 22] : [230, 237, 243, 18]),
        getLineColor: (c) => (c.est ? [176, 156, 255, 140] : [230, 237, 243, 120]),
      }),
    )
  }

  // Two link layers per class: other links first (thin, beneath), then
  // infrastructure links (router <-> router, thicker) on top.
  for (const cls of ['other', 'infra'] as const) {
    const data = links.filter((g) => g.infra === (cls === 'infra'))
    layers.push(
      new LineLayer<LinkGeom>({
        id: `links-${cls}`, ...UNDER_LABELS, data: data.filter((g) => !g.inferred),
        getSourcePosition: (g) => g.path[0], getTargetPosition: (g) => g.path[1], widthUnits: 'pixels', getWidth: LINK_WIDTH[cls],
        getColor: linkColor, pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 80],
        updateTriggers: { getColor: [sel] },
      }),
      new PathLayer<LinkGeom, PathStyleExtensionProps<LinkGeom>>({
        id: `links-${cls}-inferred`, ...UNDER_LABELS, data: data.filter((g) => g.inferred), getPath: (g) => g.path, widthUnits: 'pixels', getWidth: LINK_WIDTH[cls],
        getColor: linkColor, getDashArray: [4, 3], dashJustified: true, extensions: [dashExt],
        pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 80],
        updateTriggers: { getColor: [sel] },
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
      getFillColor: (p) => (p.kind === 'estimated' ? [0, 0, 0, 0] : matches(p) ? [...ageColor(p.age), 255] : [80, 85, 90, 120]) as RGBA,
      getLineColor: (p) =>
        (isSel(p.node.id) ? [255, 255, 255, 255]
          : p.kind === 'estimated' ? (matches(p) ? [...ageColor(p.age), 255] : [80, 85, 90, 120])
          : p.node.is_gateway ? [76, 201, 240, 255] : [14, 17, 22, 255]) as RGBA,
      getLineWidth: (p) => (isSel(p.node.id) ? 3 : p.kind === 'estimated' || p.node.is_gateway ? 2 : 1),
      pickable: true, autoHighlight: true, highlightColor: [76, 201, 240, 160],
      updateTriggers: { getFillColor: [q], getLineColor: [sel, q], getLineWidth: [sel] },
    }),
  )

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
          widthUnits: 'pixels', getWidth: 1, getColor: [230, 237, 243, 150], pickable: false,
        }),
      )
    }
    layers.push(
      new TextLayer<LabelDatum>({
        id: 'node-labels', ...UNDER_LABELS, data: labels, getPosition: (l) => l.pos,
        getText: (l) => l.text, getSize: 18,
        // Collapsed names sit above their marker; fanned-out names centre on their slot.
        getPixelOffset: (l) => (l.exploded ? [0, 0] : [0, -(roleRadius(l.node.node.identity?.role) + 12)]),
        getColor: (l) => (isSel(l.node.node.id) ? [255, 255, 255, 255] : l.node.kind === 'estimated' ? [176, 156, 255, 235] : [230, 237, 243, 235]),
        // 'auto' builds the glyph atlas from the names (Æ, Ø, Å, emoji); the default is ASCII only.
        characterSet: 'auto', fontFamily: 'system-ui, sans-serif', fontWeight: 600,
        outlineWidth: 3, outlineColor: [14, 17, 22, 255], fontSettings: { sdf: true, fontSize: 64, buffer: 16, radius: 16 },
        // Pickable so hovering a name opens its cluster and clicking a fanned-out name selects it.
        pickable: true,
        updateTriggers: { getColor: [sel] },
      }),
    )
  }
  return layers
}
