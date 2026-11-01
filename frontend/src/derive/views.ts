// The views the WebAssembly engine builds (frontend/engine/src/views.rs and
// packets.rs). Their bodies kept the shapes of the retired server views
// (D-041); the engine is the source of truth for them now. The worker adds
// a small `meta` block of its own (ViewMeta).

export type SignatureStatus = 'verified' | 'unsigned' | 'unverifiable' | 'not-applicable'

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
  source?: 'mapreport' // from the node's own map report: no NodeInfo in the window
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
  moved_at?: string // last moved more than a few hundred metres: links use only later evidence (D-073)
  track?: { lat: number; lon: number; alt?: number; at: string }[] // its positions in time order, newest last, when it moved
  airborne?: boolean // moving and reporting more than 750 m above sea level
  refined?: { lat: number; lon: number; radius_m: number; reports: number; agree: number } // narrowed from reports jumping around one place (D-077)
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
  zero_cost?: ZeroCost // hop-limit evidence that dst relays what it hears from src for free (D-068)
}

/** Packets dst rebroadcast with src's hop limit (free) or one less (spent). Directional. */
export interface ZeroCost {
  free: number
  spent: number
  likely: boolean // enough consistent evidence to call the link 0-cost
}

/** How far a node's packets reach at each hop limit (D-069). */
export interface ReachView {
  meta: ViewMeta
  origin: string
  hop_start?: number // the hop limit its own packets were sent with
  internet: boolean // internet (MQTT) links were followed too
  nodes: { id: string; need: number; via: string; free?: boolean }[] // need: smallest hop limit that reaches it
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

export interface SnapshotView {
  meta: ViewMeta
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

export interface TrafficView {
  meta: ViewMeta
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
  // The node's own map report. preset_confirmed: a default channel proves the preset is in use;
  // otherwise it may be a stale value under a custom modem config.
  reported?: { region?: string; modem_preset?: string; preset_confirmed?: boolean; at: string }
  channels?: ChannelUse[] // channels it was seen on (D-064)
  preset?: PresetGuess // its modem preset as far as the window shows (D-064)
}

export interface ChannelUse {
  name: string
  sent: number // its own packets uplinked on this channel
  uplinked: number // others' receptions it uplinked on this channel, as a gateway
  primary?: boolean // its primary channel, from its own map report
}

/** Nodes that hear each other share modem settings: a radio group shares one preset. */
export interface PresetGuess {
  preset?: string // absent on conflict
  basis: 'map_report' | 'radio_contact' | 'channel_name' | 'radio_contact_channel_name' | 'conflict'
  via?: string[] // up to five node ids the evidence rests on
  group: number // other nodes in its radio group
  conflict?: [string, number][] // presets and how many group members each
}

export interface NodeView extends MeshNode {
  meta: ViewMeta
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
  meta: ViewMeta
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
  at: string // when it was first heard: where moved nodes were then (D-073)
  meta: ViewMeta
  origin: string
  type: string
  segments: RouteSegment[]
  receptions: number
}
