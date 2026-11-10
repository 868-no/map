// The views the WebAssembly engine builds (frontend/engine/src/views/,
// packets.rs, health/ and others). Their bodies kept the shapes of the
// retired server views (D-041); the engine is the source of truth for them
// now, and their types are generated from its structs (views.gen.ts,
// D-202). The worker adds a small `meta` block of its own (ViewMeta).

import type { Health, LinkHistory as LinkHistoryBody, NodeDetail, PacketLog as PacketLogBody, PacketRoute as PacketRouteBody, Reach, RegionsView as RegionsBody, Snapshot, Traffic, Watched } from './views.gen'

export type {
  Answer,
  Counts,
  Edge,
  FirmwareCount,
  Fleet,
  FleetCount,
  Hearing,
  Issue,
  MeshNode,
  NodeAirtime,
  Radio,
  RegionSummary,
  Reply,
  RouterQuality,
  RouteSegment,
  Watched,
} from './views.gen'

export interface ViewWindow {
  start: string
  end: string
  rolling: boolean
}

/** Added by the derivation worker to every view. */
export interface ViewMeta {
  window: ViewWindow // the window the view was built for
  data_until: string // newest instant the browser's copy covers (last sync or newest row)
}

/** Why the worker could not build a view (D-041: no HTTP emulation). */
export type ViewErrorKind = 'not_found' | 'bad_request' | 'unavailable' | 'upstream' | 'internal'

export class ViewError extends Error {
  constructor(public kind: ViewErrorKind, message: string) {
    super(message)
  }
}

/** A view as the worker hands it out: the engine's body and the worker's meta block. */
type View<T> = T & { meta: ViewMeta }

export type SnapshotView = View<Snapshot>
export type TrafficView = View<Traffic>
/** The node panel's view: the whole node, with the panel's own parts. */
export type NodeView = View<NodeDetail>
export type PacketLog = View<PacketLogBody>
export type PacketRoute = View<PacketRouteBody>
/** Known problems found by the engine's health rules, and the airtime estimate (D-095). */
export type HealthView = View<Health>
/** How far a node's packets reach at each hop limit (D-069). */
export type ReachView = View<Reach>
/** One link's evidence over time, per direction (D-105). */
export type LinkHistory = View<LinkHistoryBody>
/** The watchlist's nodes (D-192): the engine sends them wrapped in an object. */
export type WatchView = View<{ nodes: Watched[] }>
/** The window per region (D-194, D-196). */
export type RegionsView = View<RegionsBody>

/** Most entries per list the engine sends in a packet log (engine packets.rs MAX_LOG). */
export const PACKET_LOG_MAX = 200
