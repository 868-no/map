import type { components } from './schema'

type S = components['schemas']
export type Capabilities = S['CapabilitiesBody']
export type Retention = S['RetentionBody']
export type LiveEvent = S['LiveEvent']
export type ObsRow = S['ObsRow']
export type NodeKey = S['NodeKeyBody']
export type Weather = S['WeatherBody']
export type WeatherHour = S['Hour']
export type TerrainProfile = S['TerrainProfileBody']
export type TerrainSample = S['Sample']
export type TerrainClasses = S['TerrainClassesOutputBody']
