// Messages between the page and the derivation worker.
import type { Capabilities, ObsRow } from '../api/types'
import type { WindowReq } from './rowStore'
import type { ViewErrorKind, ViewMeta } from './views'

export type ViewKind = 'snapshot' | 'traffic' | 'node' | 'packetlog' | 'route' | 'reach'

export interface ViewRequest {
  type: 'view'
  id: number
  kind: ViewKind
  win: WindowReq
  filters: { channels: string[]; brokers: string[]; types: string[] }
  node?: string // node id for kinds 'node', 'packetlog' and 'reach' (with '|internet' to follow MQTT links); logical packet key for 'route'
  epoch: string // changes when a rolling window should look for new rows
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

export type Request = ViewRequest | InitRequest | RowsRequest

/** A transmission one live reception proves (from the engine). */
export interface Transmission {
  key: string // packet + transmitter: one ping per RF transmission
  tx: string
  rx?: string
  rebroadcast: boolean
  strength?: number // 0..1 signal measured at rx, when rx is the reporting gateway
}

export type Response =
  | { id: number; ok: true; body: Uint8Array; meta: ViewMeta; offline: boolean } // body: UTF-8 JSON without meta, transferred
  | { id: number; ok: false; kind: ViewErrorKind; message: string }
  | { type: 'changed' } // live rows arrived: views are worth rebuilding
  | { type: 'pings'; transmissions: Transmission[] }
  | { type: 'fatal'; message: string } // the engine trapped or failed to start: restart the worker
