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

export type Request = ViewRequest | InitRequest | RowsRequest | TerrainRequest

/** A transmission one live reception proves (from the engine). */
export interface Transmission {
  key: string // packet + transmitter: one ping per RF transmission
  tx: string
  rx?: string
  rebroadcast: boolean
  strength?: number // 0..1 signal measured at rx, when rx is the reporting gateway
  delivered?: boolean // not radio: an ACK proving rx received tx's packet (D-096)
  packet?: string // "origin:id" of the packet transmitted (D-106)
  replay?: boolean // reconstructed from a traceroute reply: skipped if that packet was already animated (D-106)
  after?: string // a traceroute reply: the request ("origin:id") whose way to the target is drawn first
}

export type Response =
  | { id: number; ok: true; body: Uint8Array; meta: ViewMeta; offline: boolean } // body: UTF-8 JSON without meta, transferred
  | { id: number; ok: false; kind: ViewErrorKind; message: string }
  | { type: 'changed' } // live rows arrived: views are worth rebuilding
  | { type: 'pings'; transmissions: Transmission[] }
  | { type: 'fatal'; message: string } // the engine trapped or failed to start: restart the worker
