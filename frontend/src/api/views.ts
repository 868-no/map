// The views the WebAssembly engine builds (frontend/engine/src/views.rs and
// packets.rs). They kept the shapes of the retired server views (D-041), so
// the UI did not change; the engine is the source of truth for them now.

export type SignatureStatus = 'verified' | 'unsigned' | 'unverifiable' | 'not-applicable'

export interface WindowEcho {
  start: string
  end: string
  rolling: boolean
}

export interface Meta {
  window: WindowEcho
  revision: string
  filters: { channels?: string[]; brokers?: string[]; types?: string[] }
  generated_at: string
}

export interface Stats {
  n: number
  median?: number
  min?: number
  max?: number
  last?: number
}

export interface Identity {
  long_name?: string
  short_name?: string
  hw_model?: string
  role?: string
  has_public_key: boolean
  signature: SignatureStatus
  observed_at: string
}

export interface Position {
  lat: number
  lon: number
  alt?: number
  precision_bits: number
  precision_known: boolean
  signature: SignatureStatus
  observed_at: string
  source: 'position' | 'mapreport'
}

export interface Telemetry {
  battery?: number
  voltage?: number
  ch_util?: number
  air_util?: number
  uptime?: number
  observed_at: string
}

export interface Estimate {
  lat: number
  lon: number
  uncertainty_radius_m: number
  method: 'weighted_centroid' | 'log_distance_wls'
  quality: 'very_low' | 'low'
  anchor_count: number
  sample_count: number
  anchors: string[]
  evidence_from: string
  evidence_to: string
  reasons: string[]
}

export interface MeshNode {
  id: string
  num: number
  status: 'observed' | 'referenced'
  identity?: Identity
  position?: Position
  telemetry?: Telemetry
  first_seen?: string
  last_seen?: string
  packets: number // unique packets originated in the window
  receptions: number // gateway receptions of those packets
  gateway_receptions: number // receptions this node uplinked as a gateway
  is_gateway: boolean
  signatures: { verified: number; unsigned: number; unverifiable: number; not_applicable: number }
  brokers?: string[]
  mqtt_opt_out?: boolean // sent packets without OK-to-MQTT through another gateway: unnamed
  estimate?: Estimate // approximate location from in-window links; never a reported position
  estimate_note?: string // why an unpositioned node has no estimate
  mqtt_downlink?: { zero_snr: number; traceroutes: number } // probably transmits packets from MQTT (D-054)
}

/** Directed src -> dst: dst heard src. */
export interface Edge {
  src: string
  dst: string
  src_num: number
  dst_num: number
  evidence: { neighbor: number; traceroute: number; direct_rf: number; relay_hint: number }
  samples: number
  confidence: 'high' | 'medium' | 'low'
  inferred: boolean // only relay-hint inference
  reason: string
  snr: Stats // dB at dst
  rssi: Stats // dBm at dst (gateway receptions only)
  first_at: string
  last_at: string
  mqtt?: boolean // carried over MQTT, not radio: traceroute hops recorded at exactly 0 dB (D-055)
}

export interface Counts {
  packets: number
  receptions: number
  nodes: number
  referenced: number
  positioned: number
  estimated: number
  edges: number
  by_type: Record<string, number>
  first_event?: string
  last_event?: string
  nodes_truncated: boolean
}

export interface SnapshotBody {
  meta: Meta
  nodes: MeshNode[]
  edges: Edge[]
  edges_truncated: boolean
  counts: Counts
  diagnostics: { relay_ambiguous: number; relay_unmatched: number }
}

export interface Bucket {
  start: string
  packets: number
  receptions: number
  by_type?: Record<string, number>
}

export interface TrafficBody {
  meta: Meta
  bucket: string
  buckets: Bucket[]
  packets: number
  receptions: number
}

export interface Hearing {
  node: string
  receptions: number
  direct_rf: number
  snr: Stats
  rssi: Stats
  last_at: string
}

/** One way a node was heard: an MQTT topic root and channel name. */
export interface HeardAs {
  topic: string
  regions: string[] // LoRa regions the topic allows (empty: unknown)
  channel?: string
  preset?: string // e.g. NARROW_FAST; absent when the channel name is not a preset's default name
  receptions: number
  last_at: string
}

export interface Radio {
  heard_as: HeardAs[]
  reported?: { region?: string; modem_preset?: string; at: string } // the node's own map report
}

export interface NodeBody extends MeshNode {
  meta: Meta
  positions: { at: string; lat: number; lon: number; precision_bits: number; precision_known: boolean; signature: string }[]
  telemetry_series: { at: string; battery?: number; voltage?: number; ch_util?: number; air_util?: number }[]
  heard_by: Hearing[]
  heard: Hearing[]
  recent_packets: { at: string; type: string; packet_id: number; to?: string; channel?: string; signature: string; crypto: string; receptions: number; bytes: number }[]
  truncated: boolean
  radio: Radio
}

export interface OwnPacket {
  lp: string // logical packet key
  at: string
  type: string
  to?: string
  channel?: string
  hops?: number // fewest hops any gateway saw
  gateways: number
  receptions: number
  signature: string
}

export interface RelayedPacket {
  lp: string
  at: string // first evidence of this node relaying it
  origin: string
  type: string
  to?: string
  evidence: ('relay_byte' | 'traceroute')[]
  gateways: string[] // heard this node's rebroadcast
}

export interface PacketLog {
  meta: Meta
  own: OwnPacket[]
  relayed: RelayedPacket[]
  truncated: boolean
}

export interface RouteSegment {
  a: string // transmitter
  b: string // receiver
  dashed: boolean // nodes between a and b are missing
  why: 'direct' | 'traceroute' | 'relay' | 'gap' | 'unknown_relay'
}

export interface PacketRoute {
  meta: Meta
  origin: string
  type: string
  segments: RouteSegment[]
  receptions: number
}
