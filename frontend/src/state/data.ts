import { keepPreviousData, useQuery, type Query } from '@tanstack/react-query'
import { useMemo } from 'react'
import { getJSON, matchesRequest } from '../api/client'
import type { Capabilities, NodeBody, Retention, SnapshotBody, TrafficBody } from '../api/types'
import { apiParams, useStore } from './store'
import { create } from 'zustand'
import { deriveMode, deriveView, onDerivedChange } from '../derive/client'
import type { ViewKind } from '../derive/protocol'
import type { PacketLog } from '../derive/packetlog'
import type { PacketRoute } from '../derive/route'
import { usePwa } from '../pwa'

/** Where views are built: in the browser (default) or by the server. Fixed for the page's lifetime. */
export const DERIVE = deriveMode()

/**
 * epoch: bumped by live heartbeats to refresh rolling-window views (a sync
 * with the server). rev: bumped when streamed rows changed the browser's
 * copy, to rebuild views without any request.
 */
export const useLiveEpoch = create<{ epoch: string; rev: number; bump: (e: string) => void }>((set) => ({
  epoch: '',
  rev: 0,
  bump: (epoch) => set({ epoch }),
}))
if (DERIVE === 'client') onDerivedChange(() => useLiveEpoch.setState((s) => ({ rev: s.rev + 1 })))

export function useCapabilities() {
  return useQuery({ queryKey: ['capabilities'], queryFn: ({ signal }) => getJSON<Capabilities>('/api/v1/capabilities', undefined, signal), staleTime: 300_000 })
}

export function useRetention() {
  return useQuery({ queryKey: ['retention'], queryFn: ({ signal }) => getJSON<Retention>('/api/v1/retention', undefined, signal), refetchInterval: 300_000 })
}

/** Current API params plus a stable identity for "same window, rolling forward". */
export function useWindowParams() {
  const win = useStore((s) => s.win)
  const filters = useStore((s) => s.filters)
  const epoch = useLiveEpoch((s) => s.epoch)
  return useMemo(() => {
    const params = apiParams({ win, filters })
    const identity = win.live ? `live:${win.durationH}:${filters.channels}:${filters.brokers}:${filters.types}` : `fixed:${params}`
    return { params, identity, epoch: win.live ? epoch : '' }
  }, [win, filters, epoch])
}

type Key = readonly [string, string, string, string]

/**
 * Keep showing the previous result while loading only when that cannot leak
 * data: the same rolling window moving forward. A different window shows a
 * loading state instead.
 */
function safePlaceholder<T>(prev: T | undefined, prevQuery: Query<T, Error, T, Key> | undefined, key: Key): T | undefined {
  if (!prev || !prevQuery) return undefined
  const [, , pIdentity] = prevQuery.queryKey
  const [, , identity] = key
  if (identity.startsWith('live:') && pIdentity === identity) return keepPreviousData(prev)
  return undefined
}

function useWindowQuery<T extends { meta: SnapshotBody['meta'] }>(kind: ViewKind, path: string, node?: string, enabled = true) {
  const { params, identity, epoch } = useWindowParams()
  const win = useStore((s) => s.win)
  const filters = useStore((s) => s.filters)
  const rev = useLiveEpoch((s) => s.rev)
  const key: Key = [kind + (node ? ':' + node : ''), params.toString(), identity, win.live && DERIVE === 'client' ? `${epoch}#${rev}` : epoch]
  return useQuery<T, Error, T, Key>({
    queryKey: key,
    enabled,
    queryFn: async ({ signal }) => {
      let body: T
      if (DERIVE === 'client') {
        const r = await deriveView({
          kind, node, epoch,
          win: win.live ? { live: true, durationH: win.durationH } : { live: false, start: win.start!, end: win.end! },
          filters: { channels: filters.channels, brokers: filters.brokers, types: filters.types },
        }, signal)
        if (usePwa.getState().servedOffline !== r.offline) usePwa.setState({ servedOffline: r.offline })
        body = r.body as T
      } else body = await getJSON<T>(path, params, signal)
      if (!matchesRequest(body.meta, params)) throw new Error('stale response for a different window')
      return body
    },
    // TanStack's NonFunctionGuard<T> cannot be expressed for a generic T.
    placeholderData: ((prev: T | undefined, prevQuery: Query<T, Error, T, Key> | undefined) => safePlaceholder<T>(prev, prevQuery, key)) as never,
    staleTime: 5_000,
    retry: 1,
  })
}

export const useSnapshot = () => useWindowQuery<SnapshotBody>('snapshot', '/api/v1/snapshot')
export const useTraffic = () => useWindowQuery<TrafficBody>('traffic', '/api/v1/traffic')
/** The node's own and relayed packets; built in the browser only (D-036). */
export function usePacketLog(id: string | null) {
  return useWindowQuery<PacketLog & { meta: SnapshotBody['meta'] }>('packetlog', '', id ?? undefined, !!id && DERIVE === 'client')
}

/** One packet's routing graph (browser-built views only). */
export function usePacketRoute(lp: string | null) {
  return useWindowQuery<PacketRoute & { meta: SnapshotBody['meta'] }>('route', '', lp ?? undefined, !!lp && DERIVE === 'client')
}

export function useNodeDetail(id: string | null) {
  return useWindowQuery<NodeBody>('node', `/api/v1/nodes/${encodeURIComponent(id ?? '')}`, id ?? undefined, !!id)
}
