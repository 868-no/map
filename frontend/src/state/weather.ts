// Hourly weather at stationary routers from MET Norway's analysis (D-133),
// fetched through our own server: the browser asks for no third-party data.
import { useQueries } from '@tanstack/react-query'
import { getJSON } from '../api/client'
import type { Weather, WeatherHour } from '../api/types'
import type { MeshNode } from '../derive/views'
import { isInfraRole } from '../map/model'
import { useCapabilities } from './data'

const HOUR = 3_600_000

/**
 * Where a node's weather is read, or null. Only ROUTER and ROUTER_LATE nodes
 * with a current reported position qualify: they are few and stay put, and
 * the server keeps the weather of live ones ready.
 */
export function weatherSite(n: MeshNode | undefined): { lat: number; lon: number } | null {
  if (!n || !isInfraRole(n.identity?.role) || !n.position) return null
  const p = n.refined ?? n.position
  return { lat: p.lat, lon: p.lon }
}

/** Points to 3 decimals (about 100 m, finer than the 1 km grid) so nearby requests share a cache entry. */
const round = (v: number) => Math.round(v * 1000) / 1000

/**
 * Weather for each site over [start, end), rounded out to whole hours so a
 * rolling window asks again only when the hour turns. While the server is
 * still fetching hours, it asks again every few seconds.
 */
export function useWeather(sites: ({ lat: number; lon: number } | null)[], start: number, end: number) {
  const caps = useCapabilities()
  const enabled = !!caps.data?.features.weather && Number.isFinite(start) && Number.isFinite(end) && end > start
  const s = new Date(Math.floor(start / HOUR) * HOUR).toISOString()
  const e = new Date(Math.ceil(end / HOUR) * HOUR).toISOString()
  return useQueries({
    queries: sites.map((site) => {
      const lat = site ? round(site.lat) : 0, lon = site ? round(site.lon) : 0
      return {
        queryKey: ['weather', lat, lon, s, e],
        enabled: enabled && !!site,
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          getJSON<Weather>('/api/v1/weather', new URLSearchParams({ lat: String(lat), lon: String(lon), start: s, end: e }), signal),
        staleTime: 10 * 60_000,
        retry: false,
        refetchInterval: (q: { state: { data?: Weather } }) => (q.state.data?.incomplete ? 4000 : false),
      }
    }),
  })
}

/** [ms, value] points of one quantity. */
export const weatherPoints = (hours: WeatherHour[] | null | undefined, k: 'temp_c' | 'precip_mm' | 'humidity_pct' | 'cloud_pct' | 'wind_ms' | 'gust_ms'): [number, number][] =>
  (hours ?? []).flatMap((h) => (h[k] != null ? [[Date.parse(h.t), h[k]!] as [number, number]] : []))

/** The hourly mean of several sites' series, over the hours any of them has. */
export function meanPoints(series: [number, number][][]): [number, number][] {
  const sum = new Map<number, [number, number]>()
  for (const s of series) for (const [t, v] of s) {
    const a = sum.get(t) ?? [0, 0]
    sum.set(t, [a[0] + v, a[1] + 1])
  }
  return [...sum].sort((a, b) => a[0] - b[0]).map(([t, [v, n]]) => [t, v / n])
}
