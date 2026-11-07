// The views the WebAssembly engine builds (frontend/engine/src/views/ and
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

/** A node's identity as the snapshot sends it: what the map and lists show. */
export interface MapIdentity {
  long_name?: string
  short_name?: string
  role?: string
}

/** The node view's identity: with its details and provenance. */
export interface Identity extends MapIdentity {
  hw_model?: string
  has_public_key: boolean
  /** Where its node id comes from (D-142): its key (firmware 2.8+) or its hardware (2.7 and older). */
  node_id_from?: 'key' | 'hardware'
  /** On 2.7 and older: the id its key derives, which it takes on 2.8 if the key is kept. */
  key_id?: string
  signature: SignatureStatus
  observed_at: string
  source?: 'mapreport' // from the node's own map report: no NodeInfo in the window
}

/** A node's position as the snapshot sends it. */
export interface MapPosition {
  lat: number
  lon: number
  alt?: number
  precision_bits: number
  precision_known: boolean
  source: 'position' | 'mapreport'
}

/** The node view's position: with its signature and time. */
export interface Position extends MapPosition {
  signature: SignatureStatus
  observed_at: string
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
  method: 'weighted_centroid' | 'ranged_centroid' | 'log_distance_wls'
  quality: 'very_low' | 'low'
  anchor_count: number
  sample_count: number
  reasons: string[]
}

/** A reported position a direct reception rules out (D-178). */
export interface RejectedPosition extends Position {
  gateway: string
  rssi: number
  distance_m: number
  bound_m: number
}

/** A snapshot node: what the map, lists, filters and health read. The node view (NodeView) adds the panel's parts. */
export interface MeshNode {
  id: string
  num: number
  status: 'observed' | 'referenced'
  identity?: MapIdentity
  position?: MapPosition
  last_seen?: string
  packets: number // unique packets originated in the window
  receptions: number // gateway receptions of those packets
  gateway_receptions: number // receptions this node uplinked as a gateway
  is_gateway: boolean
  own_uplinks?: number // of receptions, those it uplinked itself (incl. its map reports)
  last_referenced?: string // referenced-only nodes: when last named by others
  /** Uplinks every copy of a packet it hears, not only the first (a future firmware option, D-084). */
  multi_uplink?: boolean
  brokers?: string[]
  mqtt_opt_out?: boolean // sent packets without OK-to-MQTT through another gateway: unnamed
  estimate?: Estimate // approximate location from in-window links; never a reported position
  mqtt_downlink?: { zero_snr: number; traceroutes: number } // probably transmits packets from MQTT (D-054)
  moved_at?: string // last moved more than 300 m (2 km for fixed roles): links use only later evidence (D-073, D-139)
  track?: { lat: number; lon: number; alt?: number; at: string }[] // its positions in time order, newest last, when it moved
  airborne?: boolean // moving and reporting more than 750 m above sea level
  refined?: { lat: number; lon: number; radius_m: number; reports: number; agree: number } // narrowed from reports jumping around one place (D-077)
  // Routers: packets it received with hops left where a witness gateway got them, and how many of its rebroadcasts were reported (D-078)
  relaying?: { expected: number; seen: number; witnesses: number; received_as_gateway: number }
}

/** Directed src -> dst: dst heard src. */
export interface Edge {
  src: string
  dst: string
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

/** A known problem found by the engine's health rules (D-095). */
export interface Issue {
  node: string
  kind: string
  severity: 'problem' | 'warning' | 'notice'
  summary: string
  detail: string
}

/** One node's share of the window's estimated airtime (D-095). */
export interface NodeAirtime {
  node: string
  caused: number // its packets, including the rebroadcasts of them seen
  transmitted: number // what it transmitted: its own packets and others' it relayed
  packets: number
  transmissions: number
  by_type: [string, number][] // shares of caused, largest first
}

/** Store-and-forward traffic and its airtime (D-103). */
export interface StoreForwardStats {
  packets: number
  share: number
  by_kind: [string, number, number][] // kind, packets, airtime share
  nodes: { node: string; packets: number; share: number; by_kind: [string, number][]; heartbeats_per_hour: number; replays: number; replay_bytes: number }[]
}

export interface HealthView {
  meta: ViewMeta
  issues: Issue[]
  airtime: { packets: number; transmissions: number; by_type: [string, number][]; nodes: NodeAirtime[]; store_forward: StoreForwardStats }
}

/** One link's evidence over time, per direction (D-105). */
export interface LinkPoint {
  t: number // ms
  snr?: number
  rssi?: number
  ev: 'neighbor' | 'traceroute' | 'direct_rf' | 'relay_hint'
}
export interface LinkHistory {
  meta: ViewMeta
  a: string
  b: string
  ab: LinkPoint[] // a heard by b
  ba: LinkPoint[]
}

/** A watched node's state (D-192). */
export interface Watched {
  id: string
  status: 'observed' | 'referenced' | 'absent' // absent: not in the window
  long_name?: string
  short_name?: string
  role?: string
  last_seen?: string
  quiet_ms?: number // from last heard to the newest data in the window
  usual_gap_ms?: number // its median gap between transmissions or uplinks
  quiet: boolean // quiet for much longer than usual
  battery?: number
  voltage?: number
  telemetry_at?: string
  packets: number
  gateways: number // distinct gateways that got its packets
  is_gateway: boolean
}
export interface WatchView {
  meta: ViewMeta
  nodes: Watched[]
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
  nodes_truncated: boolean
}

export interface SnapshotView {
  meta: ViewMeta
  nodes: MeshNode[]
  edges: Edge[]
  edges_truncated: boolean
  counts: Counts
}

export interface Bucket {
  start: string
  packets: number
  receptions: number
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
  snr?: number // median of the direct receptions
  rssi?: number
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
  uplink_topics?: TopicUse[] // as a gateway: MQTT topic roots it uplinked under, busiest first (D-090)
}

export interface TopicUse {
  topic: string
  regions: string[]
  receptions: number
  last_at: string
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
  direct: number // nodes it heard or was heard by itself, over the air (the group reaches further)
  conflict?: [string, number][] // presets and how many group members each
}

export interface NodeView extends Omit<MeshNode, 'identity' | 'position'> {
  meta: ViewMeta
  identity?: Identity
  position?: Position
  stale_position?: Position // newest report more than a day (a week for fixed nodes) before the window's latest data (D-094, D-138)
  rejected_position?: RejectedPosition // newest report the radio rules out: ignored (D-178)
  telemetry?: Telemetry
  first_seen?: string
  signatures: { verified: number; unsigned: number; unverifiable: number; not_applicable: number }
  estimate_note?: string // why an unpositioned node has no estimate
  telemetry_series: { at: string; battery?: number; voltage?: number; ch_util?: number; air_util?: number; uptime?: number }[]
  environment_series?: { at: string; temp?: number; humidity?: number; pressure?: number }[] // environment reports, time order (D-099)
  delivery_by_recipient?: { to: string; asked: number; acked: number; errors: number; retried: number }[] // its packets that asked for an ACK (D-109)
  node_status?: { status: string; at: string }[] // status texts it broadcast, newest first, each once (D-103)
  heard_by: Hearing[]
  truncated: boolean
  radio: Radio
  delivery?: Delivery
}

export interface OwnPacket {
  lp: string // logical packet key
  at: string
  type: string
  to?: string
  hops?: number // fewest hops any other gateway's radio copy shows (not its own uplink, not downlinked copies)
  gateways: number // other gateways that uplinked it
  by_itself?: boolean // it uplinked it itself, as a gateway
  downlinked?: boolean // some copy reached a gateway through an MQTT downlink (D-087)
  signature: string
  replies?: Reply[] // ACKs and errors answering it (D-092)
  answers?: Answer // for a routing packet: what it says
  in_response_to?: string // the node whose packet it answers (a traceroute reply, an ACK or error)
  invalid?: string // type invalid: why its content was not kept (D-093)
}

/** Routing packets from one node answering a packet. */
export interface Reply {
  from: string
  kind: string // ack | error | …
  error?: string // firmware Routing.Error name
  count: number // distinct routing packets
}

/** What a routing packet says, and the answered packet's key when in the window. */
export interface Answer {
  kind: string
  error?: string
  request_id: number
  re?: string
}

/** A routing packet or encrypted direct message addressed to the node. */
export interface InboundPacket {
  lp: string
  at: string
  origin: string
  type: string
  answers?: Answer
}

/** A node's ACKs and errors, sent and addressed to it (D-092). */
export interface Delivery {
  acks_sent: number
  acks_received: number
  errors_sent: [string, number][]
  errors_received: [string, number][]
}

export interface RelayedPacket {
  lp: string
  at: string // first evidence of this node relaying it
  origin: string
  type: string
  to?: string
  evidence: ('relay_byte' | 'traceroute')[]
  gateways: number // how many heard this node's rebroadcast
}

/** Most entries per list the engine sends in a packet log (engine packets.rs MAX_LOG). */
export const PACKET_LOG_MAX = 200

export interface PacketLog {
  meta: ViewMeta
  own: OwnPacket[]
  relayed: RelayedPacket[]
  inbound: InboundPacket[]
  truncated: boolean
}

export interface RouteSegment {
  a: string // transmitter
  b: string // receiver
  dashed: boolean // nodes between a and b are missing
  why: 'direct' | 'traceroute' | 'relay' | 'gap' | 'unknown_relay' | 'internet' | 'delivered'
  leg?: 'forward' | 'back' // a traceroute's way there (request) or back (reply)
}

export interface PacketRoute {
  at: string // when it was first heard: where moved nodes were then (D-073)
  meta: ViewMeta
  segments: RouteSegment[]
  delivered?: string[] // nodes whose ACK confirms they received it (D-096)
}
