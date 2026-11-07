// Node markers by role (D-186): one disc for every node, in its last-heard
// colour, with a glyph inside that says its role. Shared by the map's icon
// atlas (meshLayers.ts) and the legend, so both draw the same shapes.

/** The four roles a marker shows; every other role (or none) is a client. */
export type RoleIcon = 'router' | 'routerLate' | 'base' | 'client'

export function roleIcon(role: string | undefined): RoleIcon {
  switch (role) {
    case 'ROUTER':
      return 'router'
    case 'ROUTER_LATE':
      return 'routerLate'
    case 'CLIENT_BASE':
      return 'base'
    default:
      return 'client'
  }
}

/** Marker radius in screen pixels, every role alike: a 20 px disc. */
export const NODE_RADIUS = 10

/** Glyph geometry is drawn on a 16-unit disc centred on (0, 0). */
export const GLYPH_UNITS = 16
/** Stroke width of the arcs, in glyph units. */
export const GLYPH_STROKE = 1.35

// One pair of arcs for both routers, clear of the rim and with a short
// sweep, so they read as waves rather than a ring.
const ARCS = 'M-3.64,-3.28 A4.9,4.9 0 0,0 -3.64,3.28 M3.64,-3.28 A4.9,4.9 0 0,1 3.64,3.28'

/**
 * Each glyph: `stroke` paths drawn with GLYPH_STROKE and round caps,
 * `fill` paths filled, and `cut` paths cut out of what is drawn (the disc
 * shows through).
 */
export const ROLE_GLYPHS: Record<RoleIcon, { stroke?: string; fill?: string; cut?: string }> = {
  // The broadcast mark: relays everything, for everyone.
  router: { stroke: ARCS, fill: 'M-1.75,0 a1.75,1.75 0 1,0 3.5,0 a1.75,1.75 0 1,0 -3.5,0' },
  // The same waves around an hourglass: a router that waits.
  routerLate: { stroke: ARCS, fill: 'M-1.7,-2.75 H1.7 L0.22,-0.1 L0,0.12 L-0.22,-0.1 Z M-1.7,2.75 H1.7 L0.22,0.1 L0,-0.12 L-0.22,0.1 Z' },
  // A house: a fixed home station.
  base: { fill: 'M0,-4.6 L4.2,-0.9 V4.1 H-4.2 V-0.9 Z' },
  // A handheld device with a screen: someone's own node.
  client: {
    fill: 'M-1.75,-4.3 h3.5 a0.9,0.9 0 0 1 0.9,0.9 v6.8 a0.9,0.9 0 0 1 -0.9,0.9 h-3.5 a0.9,0.9 0 0 1 -0.9,-0.9 v-6.8 a0.9,0.9 0 0 1 0.9,-0.9 Z',
    cut: 'M-1.45,-3.25 h2.9 v3.6 h-2.9 Z',
  },
}

/** The gateway's uplink badge on the rim: centre and radius in glyph units. */
export const UPLINK_BADGE = { x: 6.3, y: -6.3, r: 3.85, rim: 0.9 }

/** Glyph units to screen pixels at NODE_RADIUS. */
export const GLYPH_PX = (NODE_RADIUS * 2) / GLYPH_UNITS
