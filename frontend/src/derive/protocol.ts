// Messages between the page and the derivation worker.
import type { Capabilities, ObsRow } from '../api/types'
import type { WindowReq } from './rowStore'
import type { ViewErrorKind, ViewMeta } from './views'

export type ViewKind = 'snapshot' | 'traffic' | 'node' | 'packetlog' | 'route' | 'reach' | 'health' | 'link'

export interface ViewRequest {
  type: 'view'
  id: number
  kind: ViewKind
  win: WindowReq
  filters: { channels: string[]; brokers: string[]; types: string[] }
  node?: string // node id for kinds 'node', 'packetlog' and 'reach' (with '|internet' to follow MQTT links); logical packet key for 'route'
  epoch: string // changes when a rolling window should look for new rows
  rev: number // the page's data revision: one rolling-window end per (epoch, rev)
}

export interface InitRequest {
  type: 'init'
  geo: Capabilities['geolocation']
  liveQuantumMs: number
  maxNodes?: number // set before init, or kept across a restart (D-182)
  terrain?: TerrainLinkClass[] // likewise (D-143)
}

/** The generation /retention reported: whole days are asked under it before /observations answers (D-170). */
export interface GenerationHint {
  type: 'generation'
  generation: string
}

/** Rows from the live stream; ping lists the indexes the page wants animated. */
export interface RowsRequest {
  type: 'rows'
  rows: ObsRow[]
  ping: number[]
}

/** Line-of-sight classes of router links, for the ranging model (D-143). */
export interface TerrainLinkClass { a: string; b: string; class: string }
export interface TerrainRequest {
  type: 'terrain'
  links: TerrainLinkClass[]
}

/** The snapshot's node limit, the most active nodes first (D-182). */
export interface OptionsRequest {
  type: 'options'
  maxNodes: number
}

/** The page stopped waiting for a view: the worker skips building it if it has not yet. */
export interface CancelRequest {
  type: 'cancel'
  id: number
}

export type Request = ViewRequest | InitRequest | GenerationHint | RowsRequest | TerrainRequest | OptionsRequest | CancelRequest

/** A transmission one live reception proves (from the engine). */
export interface Transmission {
  key: string // packet + transmitter: one ping per RF transmission
  tx: string
  rx?: string
  rebroadcast: boolean
  strength?: number // 0..1 signal measured at rx, when rx is the reporting gateway
  delivered?: boolean // not radio: an ACK proving rx received tx's packet (D-096)
  packet?: string // "origin:id" of the packet transmitted (D-106); for a delivery, the packet the ACK answers (D-172)
  replay?: boolean // reconstructed from a traceroute reply: skipped if that packet was already animated (D-106)
  after?: string // a traceroute reply: the request ("origin:id") whose way to the target is drawn first
  path?: { a: string; b: string; dashed: boolean; why: string }[] // a delivery: the answered packet's way from tx to rx, dashed where unknown (D-172)
  back?: { a: string; b: string; dashed: boolean; why: string }[] // a delivery: the ACK's way back from rx to tx, dashed where unknown (D-172)
  gap?: 'gap' | 'unknown_relay' | 'internet' // not radio: the packet's way from tx to rx, its hops not known (D-173)
}

export type Response =
  | { id: number; ok: true; body: Uint8Array; meta: ViewMeta; offline: boolean } // body: UTF-8 JSON without meta, transferred
  | { id: number; ok: false; kind: ViewErrorKind; message: string }
  | { type: 'changed' } // live rows arrived: views are worth rebuilding
  | { type: 'pings'; transmissions: Transmission[] }
  | { type: 'fatal'; message: string } // the engine trapped or failed to start: restart the worker
