// End-to-end test hook (window.__meshmap). Installed only in builds with
// VITE_E2E_HOOKS=true; production images never contain it.
import type * as maplibregl from 'maplibre-gl'
import type { Layer } from '@deck.gl/core'
import { activePings, pingCount } from './pings'

/** What the overlay picks at a pixel: the layer, and the node's id when it is one. */
type Pick = (x: number, y: number) => { layer: string; node?: string } | null

export function installTestHook(map: maplibregl.Map, layers: () => Layer[] | null, pick: Pick): void {
  if (import.meta.env.VITE_E2E_HOOKS !== 'true') return
  ;(window as unknown as Record<string, unknown>).__meshmap = {
    map,
    pings: pingCount,
    // The ping animation right now: rings, and links (with how far each has travelled).
    pingFrame: () => {
      const f = activePings(performance.now(), map.getZoom())
      return { rings: f.rings.length, trails: f.trails.map((t) => t.progress), targets: f.trails.map((t) => t.to) }
    },
    // The mesh layers currently on the map: id and data (deck.gl's public layer props).
    layers: () => (layers() ?? []).map((l) => ({ id: l.id, data: l.props.data as unknown[] })),
    // What a click at exactly (x, y) on the map would pick, ignoring the pick radius.
    pick,
    // Genuine rendered basemap label features.
    queryLabels: () => {
      const names: Record<string, string[]> = {}
      const counts: Record<string, number> = {}
      for (const f of map.queryRenderedFeatures()) {
        const id = f.layer.id
        counts[id] = (counts[id] ?? 0) + 1
        const name = (f.properties?.name as string) ?? (f.properties?.ref as string)
        if (name && !(names[id] ??= []).includes(name)) names[id].push(name)
      }
      return { counts, names }
    },
  }
}
