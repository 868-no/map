// Terrain cross sections of links from Kartverket's terrain model (D-143),
// fetched through our own server: the browser asks for no third-party data.
// Router-to-router links are classified as clear, grazing or blocked, and the
// classes are handed to the engine, whose signal-to-distance model uses only
// clear links.
import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getJSON, postJSON } from '../api/client'
import type { TerrainClasses, TerrainProfile } from '../api/types'
import type { MeshNode, SnapshotView } from '../derive/views'
import { sendTerrain } from '../derive/client'
import { isInfraRole } from '../map/model'
import { useCapabilities } from './data'

/** An end of a cross section: a reported position, and the altitude reported with it. */
export interface TerrainEnd { lat: number; lon: number; alt?: number }

/** Where a node's antenna is, from its own report; null without one (estimates do not count). */
export function terrainEnd(n: MeshNode | undefined): TerrainEnd | null {
  if (!n?.position) return null
  const p = n.refined ?? n.position
  // Meshtastic sends 0 when it has no altitude: the server then uses the terrain plus 2 m.
  return { lat: round(p.lat), lon: round(p.lon), alt: n.position.alt || undefined }
}

/** Points to 5 decimals (about 1 m): the server's grid is coarser. */
const round = (v: number) => Math.round(v * 1e5) / 1e5

/** While the server is still fetching heights: soon at first, backing off, giving up after about 15 minutes. */
const again = (q: { state: { data?: { incomplete?: boolean }; dataUpdateCount: number } }) => {
  const n = q.state.dataUpdateCount
  return q.state.data?.incomplete && n <= 25 ? Math.min(4000 * 1.3 ** n, 60_000) : false
}

/** The cross section between two ends. */
export function useTerrainProfile(a: TerrainEnd | null, b: TerrainEnd | null) {
  const caps = useCapabilities()
  return useQuery({
    queryKey: ['terrain-profile', a, b],
    enabled: !!caps.data?.features.terrain && !!a && !!b,
    queryFn: ({ signal }) => {
      const q = new URLSearchParams({ lat1: String(a!.lat), lon1: String(a!.lon), lat2: String(b!.lat), lon2: String(b!.lon) })
      if (a!.alt) q.set('alt1', String(a!.alt))
      if (b!.alt) q.set('alt2', String(b!.alt))
      return getJSON<TerrainProfile>('/api/v1/terrain/profile', q, signal)
    },
    staleTime: Infinity,
    retry: false,
    refetchInterval: again,
  })
}

interface RouterLink { a: string; b: string; ea: TerrainEnd; eb: TerrainEnd }

/** Router-to-router radio links between nodes reporting a position, once per pair. */
export function routerLinks(snap: SnapshotView | undefined): RouterLink[] {
  if (!snap) return []
  const nodes = new Map(snap.nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const out: RouterLink[] = []
  for (const e of snap.edges) {
    if (e.mqtt) continue
    const [a, b] = e.src < e.dst ? [e.src, e.dst] : [e.dst, e.src]
    const k = `${a}|${b}`
    if (seen.has(k)) continue
    seen.add(k)
    const na = nodes.get(a), nb = nodes.get(b)
    if (!isInfraRole(na?.identity?.role) || !isInfraRole(nb?.identity?.role)) continue
    const ea = terrainEnd(na), eb = terrainEnd(nb)
    if (ea && eb) out.push({ a, b, ea, eb })
  }
  return out.sort((x, y) => (x.a + x.b < y.a + y.b ? -1 : 1)).slice(0, 400)
}

/**
 * Classifies the window's router-to-router links and hands the classes to
 * the engine. Mounted once, beside the snapshot.
 */
export function useTerrainClasses(snap: SnapshotView | undefined) {
  const caps = useCapabilities()
  const links = routerLinks(snap)
  // The same links ask once, whatever else the snapshot changed.
  const key = JSON.stringify(links.map((l) => [l.a, l.b, l.ea, l.eb]))
  const q = useQuery({
    queryKey: ['terrain-classes', key],
    enabled: !!caps.data?.features.terrain && links.length > 0,
    queryFn: ({ signal }) =>
      postJSON<TerrainClasses>('/api/v1/terrain/classes', {
        links: links.map((l) => ({ lat1: l.ea.lat, lon1: l.ea.lon, alt1: l.ea.alt, lat2: l.eb.lat, lon2: l.eb.lon, alt2: l.eb.alt })),
      }, signal),
    staleTime: Infinity,
    retry: false,
    refetchInterval: again,
  })
  const classes = useMemo(() => {
    const got = q.data?.classes
    if (!got) return null
    const parsed = JSON.parse(key) as [string, string][]
    return parsed.flatMap(([a, b], i) => (got[i] && got[i].class !== 'unknown' ? [{ a, b, class: got[i].class }] : []))
  }, [q.data, key])
  const sent = useMemo(() => (classes ? JSON.stringify(classes) : null), [classes])
  useEffect(() => {
    if (sent) sendTerrain(JSON.parse(sent))
  }, [sent])
}
