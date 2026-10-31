// Messages between the page and the derivation worker.
import type { Capabilities, ObsRow } from '../api/types'
import type { WindowReq } from './rowStore'

export type ViewKind = 'snapshot' | 'traffic' | 'node' | 'packetlog' | 'route'

export interface ViewRequest {
  type: 'view'
  id: number
  kind: ViewKind
  win: WindowReq
  filters: { channels: string[]; brokers: string[]; types: string[] }
  node?: string // node id for kinds 'node' and 'packetlog'; logical packet key for 'route'
  epoch: string // changes when a rolling window should look for new rows
}

export interface InitRequest {
  type: 'init'
  geo: Capabilities['geolocation']
  liveQuantumMs: number
}

/** Rows from the live stream. */
export interface RowsRequest {
  type: 'rows'
  rows: ObsRow[]
}

export type Request = ViewRequest | InitRequest | RowsRequest

export type Response =
  | { id: number; ok: true; body: unknown; offline: boolean }
  | { id: number; ok: false; status: number; message: string }
  | { type: 'changed' } // live rows arrived: views are worth rebuilding
