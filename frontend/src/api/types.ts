import type { components } from './schema'

type S = components['schemas']
export type Capabilities = S['CapabilitiesBody']
export type Retention = S['RetentionBody']
export type LiveEvent = S['LiveEvent']
export type ObsRow = S['ObsRow']
export type ObservationsBody = S['ObservationsBody']
