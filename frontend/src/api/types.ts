import type { components } from './schema'

type S = components['schemas']
export type Capabilities = S['CapabilitiesBody']
export type Retention = S['RetentionBody']
export type LiveEvent = S['LiveEvent']
export type ObsRow = S['ObsRow']
export type ObservationsBody = S['ObservationsBody']
// Views are built in the browser by the WebAssembly engine.
export type { Edge, Estimate, Meta, MeshNode, NodeBody, PacketLog, PacketRoute, SnapshotBody, TrafficBody } from './views'
