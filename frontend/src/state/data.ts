import { keepPreviousData, useQuery, type Query } from '@tanstack/react-query'
import { useMemo } from 'react'
import { getJSON, getJSONFresh } from '../api/client'
import type { Capabilities, Retention } from '../api/types'
import type { HealthView, LinkHistory, NodeView, PacketLog, PacketRoute, ReachView, SnapshotView, TrafficView, ViewMeta } from '../derive/views'
import { apiParams, useStore } from './store'
import { create } from 'zustand'
import { deriveView, onDerivedChange } from '../derive/client'
import type { ViewKind } from '../derive/protocol'
import { usePwa } from '../pwa'
import { noteServerTime } from '../lib/serverClock'

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
onDerivedChange(() => useLiveEpoch.setState((s) => ({ rev: s.rev + 1 })))

export function useCapabilities() {
  return useQuery({ queryKey: ['capabilities'], queryFn: ({ signal }) => getJSON<Capabilities>('/api/v1/capabilities', undefined, signal), staleTime: 300_000 })
}

export function useRetention() {
  return useQuery({
    queryKey: ['retention'],
    queryFn: async ({ signal }) => {
      const { body: r, offline } = await getJSONFresh<Retention>('/api/v1/retention', signal)
      // Window ends follow the server's clock; an offline copy's time is old.
      if (!offline) noteServerTime(r.now)
      return r
    },
    refetchInterval: 300_000,
  })
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
 * data: the same view of the same subject, in the same rolling window moving
 * forward. Anything else shows a loading state instead.
 */
function safePlaceholder<T>(prev: T | undefined, prevQuery: Query<T, Error, T, Key> | undefined, key: Key): T | undefined {
  if (!prev || !prevQuery) return undefined
  const [pView, , pIdentity] = prevQuery.queryKey
  const [view, , identity] = key
  // The same view of the same node or packet only: switching selection must
  // never show the previous node's details, or frame the previous route.
  if (pView === view && identity.startsWith('live:') && pIdentity === identity) return keepPreviousData(prev)
  return undefined
}

/** A view built by the derivation worker for the current window and filters. */
function useWindowQuery<T extends { meta: ViewMeta }>(kind: ViewKind, node?: string, enabled = true) {
  const { params, identity, epoch } = useWindowParams()
  const win = useStore((s) => s.win)
  const filters = useStore((s) => s.filters)
  const rev = useLiveEpoch((s) => s.rev)
  const limitsReady = useStore((s) => s.limitsReady) // the server's window limits applied
  // rev for fixed windows too: the stream runs only for live ones, so there it
  // moves only when the worker's views changed without new rows (terrain
  // classes, D-143; the regions health checks topic roots against, D-161).
  const key: Key = [kind + (node ? ':' + node : ''), params.toString(), identity, `${epoch}#${rev}`]
  return useQuery<T, Error, T, Key>({
    queryKey: key,
    enabled: enabled && limitsReady,
    queryFn: async ({ signal }) => {
      const r = await deriveView({
        kind, node, epoch, rev,
        win: win.live ? { live: true, durationH: win.durationH } : { live: false, start: win.start!, end: win.end! },
        filters: { channels: filters.channels, brokers: filters.brokers, types: filters.types },
      }, signal)
      if (usePwa.getState().servedOffline !== r.offline) usePwa.setState({ servedOffline: r.offline })
      // No window check needed: the worker answers each request by id, for the
      // window in that request, and the result is stored under this key.
      return r.body as T
    },
    // TanStack's NonFunctionGuard<T> cannot be expressed for a generic T.
    placeholderData: ((prev: T | undefined, prevQuery: Query<T, Error, T, Key> | undefined) => safePlaceholder<T>(prev, prevQuery, key)) as never,
    staleTime: 5_000,
    // Every live rebuild is a new key: keeping old ones (5 min by default)
    // would hold dozens of dead parsed views. The observer still keeps the
    // previous result for placeholderData after its query is dropped.
    gcTime: win.live ? 0 : 5 * 60_000,
    retry: 1,
  })
}

export const useSnapshot = () => useWindowQuery<SnapshotView>('snapshot')
export const useTraffic = () => useWindowQuery<TrafficView>('traffic')
/** The node's own and relayed packets (D-036). */
export const usePacketLog = (id: string | null) => useWindowQuery<PacketLog>('packetlog', id ?? undefined, !!id)
/** One packet's routing graph (D-037). */
export const usePacketRoute = (lp: string | null) => useWindowQuery<PacketRoute>('route', lp ?? undefined, !!lp)
export const useNodeDetail = (id: string | null) => useWindowQuery<NodeView>('node', id ?? undefined, !!id)
/** One link's evidence over time (D-105). */
export const useLinkHistory = (a: string, b: string) => useWindowQuery<LinkHistory>('link', `${a}|${b}`)
/** Known issues and airtime for the window (D-095). */
export const useHealth = () => useWindowQuery<HealthView>('health')
/** How far the node's packets reach at each hop limit (D-069). */
export const useReach = (id: string | null, internet: boolean) => useWindowQuery<ReachView>('reach', id ? id + (internet ? '|internet' : '') : undefined, !!id)
