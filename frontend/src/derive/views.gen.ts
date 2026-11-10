// Generated from the engine's view structs by ts-rs (frontend/engine/src/view_types.rs,
// D-202): run `scripts/wasm.sh test` to regenerate. Do not edit by hand.

export type Airtime = { packets: number, transmissions: number, store_forward: StoreForwardStats,
/**
 * Share of the window's estimated airtime by packet type, largest first.
 */
by_type: Array<[string, number]>,
/**
 * Every node that caused or transmitted any, by caused share: the
 * node panel shows any node's, so the list is never cut.
 */
nodes: Array<NodeAirtime>, };

/**
 * A stationary node whose reports jump around one place (D-077): GPS noise
 * around a fixed spot, or reports of different precision. The agreeing
 * reports pick its place, never finer than it shared itself (design §6.10).
 */
export type Anchor = { lat: number, lon: number,
/**
 * Worst-case error of the narrowed position.
 */
radius_m: number,
/**
 * Reports (one per packet) in the window, and how many agree on the place.
 */
reports: number, agree: number, };

/**
 * What a routing packet says: ack or error, for the packet with this id.
 */
export type Answer = { kind: string, error?: string, request_id: number,
/**
 * The answered packet's key, when it is in the window.
 */
re?: string, };

export type Bucket = { start: string, packets: number, receptions: number, };

export type ChannelUse = { name: string,
/**
 * Its own packets uplinked on this channel (distinct packets).
 */
sent: number,
/**
 * Others' receptions it uplinked on this channel (as a gateway).
 */
uplinked: number,
/**
 * Its primary channel, from its own map report.
 */
primary?: boolean, };

export type Counts = { packets: number, receptions: number, nodes: number, referenced: number, positioned: number, estimated: number, edges: number, nodes_truncated: boolean, };

/**
 * A node's routing traffic in the window: ACKs and errors it sent, and
 * those addressed to it, errors by firmware reason (D-092).
 */
export type Delivery = { acks_sent: number, acks_received: number, errors_sent: Array<[string, number]>, errors_received: Array<[string, number]>, };

/**
 * Evidence that a node takes packets from an MQTT broker (downlink) and
 * transmits them: traceroutes record the SNR each hop received at, and a
 * packet that arrived from MQTT has no radio reception, so it is recorded
 * at exactly 0 dB. Genuine readings round to 0 dB too, on 1-11% of a node's
 * traceroutes in the 2026-11 data; downlinking gateways sat at 52-79% (D-054).
 */
export type Downlink = { zero_snr: number, traceroutes: number, };

/**
 * Directed src -> dst: dst heard src.
 */
export type Edge = { src: string, dst: string, evidence: EvidenceCounts, samples: number, confidence: 'high' | 'medium' | 'low', inferred: boolean, reason: string, snr: Stats, rssi: Stats, first_at: string, last_at: string,
/**
 * Carried over MQTT, not radio: built only from traceroute hops recorded
 * at exactly 0 dB (D-055). Kept apart from radio links.
 */
mqtt?: boolean,
/**
 * Hop-limit evidence that dst relays what it hears from src without
 * spending a hop (D-068); absent without any.
 */
zero_cost?: ZeroCost, };

/**
 * One environment report (D-099).
 */
export type EnvironmentSample = { at: string, temp?: number, humidity?: number, pressure?: number, };

export type Estimate = { lat: number, lon: number, uncertainty_radius_m: number, method: 'weighted_centroid' | 'ranged_centroid' | 'log_distance_wls', quality: 'very_low' | 'low', anchor_count: number, sample_count: number, reasons: Array<string>, };

export type EvidenceCounts = { neighbor: number, traceroute: number, direct_rf: number, relay_hint: number, };

/**
 * Nodes on one firmware line, or of one inferred generation.
 */
export type FirmwareCount = {
/**
 * "reported": the major.minor of the version its map report states;
 * inferred, never a version: "key" (2.8 or later), "hardware" (2.7 or
 * earlier), "no_hop_start" (before 2.3); "unknown".
 */
basis: 'reported' | 'key' | 'hardware' | 'no_hop_start' | 'unknown',
/**
 * The major.minor, e.g. "2.7" (reported only).
 */
version?: string, nodes: number,
/**
 * The exact versions within it, newest first (reported only).
 */
versions?: Array<FleetCount>, };

/**
 * The breakdown of a set of nodes. Each list: most nodes first, then by
 * name, "unknown" last; firmware: reported lines newest first, then the
 * inferred generations newest first, then "unknown".
 */
export type Fleet = {
/**
 * Nodes counted: those heard in the window (not only named by others).
 */
nodes: number, roles: Array<FleetCount>, hardware: Array<FleetCount>, presets: Array<FleetCount>, firmware: Array<FirmwareCount>, };

/**
 * One value and how many nodes have it.
 */
export type FleetCount = { name: string, nodes: number, };

export type Health = { issues: Array<Issue>, airtime: Airtime, };

/**
 * One way the node was heard: a topic root and channel name.
 */
export type HeardAs = { topic: string, regions: Array<string>, channel?: string, preset?: string, receptions: number, last_at: string, };

export type Hearing = { node: string, receptions: number, direct_rf: number,
/**
 * Medians over the direct receptions: a relayed copy's measures the last relay.
 */
snr?: number, rssi?: number, };

export type Identity = { long_name?: string, short_name?: string, hw_model?: string, role?: string, has_public_key: boolean,
/**
 * Where its node id comes from (D-142): "key" (firmware 2.8 and later
 * derive it from the public key) or "hardware" (2.7 and earlier); absent
 * without an announced key.
 */
node_id_from?: 'key' | 'hardware',
/**
 * The node id its key derives, when that is not its own (a 2.7 node: the
 * id it takes on upgrading to 2.8 with its key kept).
 */
key_id?: string, signature: 'verified' | 'unsigned' | 'unverifiable' | 'not-applicable', observed_at: string,
/**
 * "mapreport" when the identity comes from the node's own map report
 * (no NodeInfo in the window); empty for NodeInfo.
 */
source?: 'mapreport', };

/**
 * A routing packet or encrypted direct message addressed to the node.
 */
export type InboundPacket = { lp: string, at: string, origin: string, type: string, answers?: Answer, };

export type Issue = { node: string, kind: string,
/**
 * problem, warning or notice.
 */
severity: 'problem' | 'warning' | 'notice', summary: string, detail: string, };

export type LinkHistory = { a: string, b: string,
/**
 * a heard by b (a transmitted, b received), oldest first.
 */
ab: Array<LinkPoint>, ba: Array<LinkPoint>,
/**
 * The noise floor each end measures, [Unix ms, dBm], oldest first, the
 * newest MAX_LINK_POINTS; empty for an end that sent none (D-199).
 */
floor_a?: Array<[number, number]>, floor_b?: Array<[number, number]>, };

export type LinkPoint = {
/**
 * Observed, Unix ms.
 */
t: number, snr?: number, rssi?: number, ev: 'neighbor' | 'traceroute' | 'direct_rf' | 'relay_hint', };

export type MapIdentity = { long_name?: string, short_name?: string, role?: string, };

export type MapPosition = { lat: number, lon: number, alt?: number, precision_bits: number, precision_known: boolean, source: 'position' | 'mapreport', };

export type MeshNode = { id: string, num: number, status: 'observed' | 'referenced', identity?: MapIdentity, position?: MapPosition, last_seen?: string, last_referenced?: string, packets: number, receptions: number, own_uplinks?: number, gateway_receptions: number, is_gateway: boolean, multi_uplink?: boolean, brokers?: Array<string>, mqtt_opt_out?: boolean, estimate?: Estimate, mqtt_downlink?: Downlink, moved_at?: string, track?: Array<TrackPoint>, airborne?: boolean, refined?: Anchor, relaying?: Relaying, };

/**
 * One node's share of the window's estimated airtime.
 */
export type NodeAirtime = { node: string,
/**
 * Its packets, including every rebroadcast of them seen (the airtime it causes).
 */
caused: number,
/**
 * What it transmitted itself: its own packets and others' it relayed.
 */
transmitted: number, packets: number,
/**
 * Transmissions of its packets seen: its own plus relays'.
 */
transmissions: number,
/**
 * Its caused airtime by packet type, as shares of `caused`, largest first.
 */
by_type: Array<[string, number]>, };

export type NodeDetail = { telemetry_series: Array<TelemetrySample>,
/**
 * Its packets that asked for an ACK, by recipient, most first (D-109).
 */
delivery_by_recipient?: Array<PairDelivery>,
/**
 * Its status texts, newest first: each distinct text once, at its latest (D-103).
 */
node_status?: Array<StatusText>,
/**
 * Environment reports in time order, one per packet (D-099).
 */
environment_series?: Array<EnvironmentSample>,
/**
 * The noise floor it measures, [Unix ms, dBm], one per local statistics
 * packet, in time order (D-199).
 */
noise_floor_series?: Array<[number, number]>, heard_by: Array<Hearing>,
/**
 * A series kept only its newest MAX_SAMPLES reports.
 */
truncated: boolean,
/**
 * Region and LoRa preset as heard (topics, channel names) and as reported.
 */
radio: Radio,
/**
 * ACKs and errors it sent and received (D-092).
 */
delivery?: Delivery,
/**
 * A router's link quality to other routers over the window (D-197).
 */
router_links?: RouterQuality, id: string, num: number, status: 'observed' | 'referenced', identity?: Identity, position?: Position,
/**
 * Its newest reported position, when that is older than STALE_POSITION_MS
 * before the window's latest observation (D-094): it is then no anchor
 * and the node is estimated; without an estimate it is left off the map,
 * since links drawn to an old place would mislead.
 */
stale_position?: Position,
/**
 * Its newest position report the radio contradicts (D-178): ignored,
 * so the node is placed by its other reports or estimated.
 */
rejected_position?: RejectedPosition, telemetry?: Telemetry, first_seen?: string, last_seen?: string,
/**
 * For a node only named by others (status "referenced"): when it was last named.
 */
last_referenced?: string, packets: number, receptions: number,
/**
 * Of `receptions`, those it uplinked itself as a gateway (its own map
 * reports among them): not heard over the air by anyone else.
 */
own_uplinks?: number, gateway_receptions: number, is_gateway: boolean,
/**
 * A gateway that uplinks every copy of a packet it hears, not only the
 * first (a future firmware option, D-084).
 */
multi_uplink?: boolean, signatures: Signatures, brokers?: Array<string>, mqtt_opt_out?: boolean, estimate?: Estimate, estimate_note?: string, mqtt_downlink?: Downlink,
/**
 * When it last moved more than a few hundred metres (D-073): links use
 * only evidence from after that.
 */
moved_at?: string,
/**
 * Its positions in time order, newest last, when it moved (D-073).
 */
track?: Array<TrackPoint>,
/**
 * Moving and reporting more than 750 m above sea level (D-073).
 */
airborne?: boolean,
/**
 * Its position narrowed from reports jumping around one place (D-077);
 * the map places it here rather than at the latest report.
 */
refined?: Anchor,
/**
 * Routers: how often it is seen relaying what it should relay (D-078).
 */
relaying?: Relaying, };

export type OwnPacket = { lp: string, at: string, type: string, to?: string,
/**
 * The fewest hops any other gateway's copy shows (hop start minus hop
 * limit; 0-cost relays do not count). Its own uplink and copies taken
 * from MQTT (downlinked) are left out: they say nothing about the path.
 */
hops?: number,
/**
 * Other gateways that uplinked it.
 */
gateways: number,
/**
 * It uplinked it itself, as a gateway.
 */
by_itself?: boolean,
/**
 * Some copy reached a gateway through an MQTT downlink (D-087).
 */
downlinked?: boolean, signature: string,
/**
 * ACKs and errors answering it, by who sent them (D-092).
 */
replies?: Array<Reply>,
/**
 * For a routing packet: what it says and which packet it answers.
 */
answers?: Answer,
/**
 * The node whose packet this answers (a traceroute reply, an ACK or
 * error): the node did not send it of its own accord.
 */
in_response_to?: string,
/**
 * Type invalid: why its content was not kept (D-093).
 */
invalid?: string, };

export type PacketLog = { own: Array<OwnPacket>, relayed: Array<RelayedPacket>, inbound: Array<InboundPacket>, truncated: boolean, };

export type PacketRoute = {
/**
 * When it was first heard: where moved nodes were then (D-073).
 */
at: string, segments: Array<RouteSegment>,
/**
 * Nodes whose ACK confirms they received it (D-096).
 */
delivered?: Array<string>, };

/**
 * Its packets to one node that asked for an acknowledgement, and what came
 * back (D-109). Lower bounds: only packets and ACKs a gateway reported count.
 */
export type PairDelivery = { to: string, asked: number,
/**
 * Confirmed: an ACK, or a reply from the recipient answering it (a
 * traceroute is answered with its reply, rarely an ACK).
 */
acked: number,
/**
 * Answered with an error (and never ACKed).
 */
errors: number,
/**
 * ACKed only after the sender retried (several ACKs for one packet).
 */
retried: number, };

export type Position = { lat: number, lon: number, alt?: number, precision_bits: number, precision_known: boolean, signature: 'verified' | 'unsigned' | 'unverifiable' | 'not-applicable', observed_at: string, source: 'position' | 'mapreport', };

export type PresetGuess = {
/**
 * The preset, when the evidence agrees; None on conflict.
 */
preset?: string,
/**
 * "map_report": its own confirmed map report; "radio_contact": confirmed
 * map reports of nodes it shares radio settings with; "channel_name" /
 * "radio_contact_channel_name": default channel names (a hint);
 * "conflict": its radio group's confirmed reports disagree.
 */
basis: 'map_report' | 'radio_contact' | 'channel_name' | 'radio_contact_channel_name' | 'conflict',
/**
 * Up to five nodes whose evidence it rests on (radio contact bases).
 */
via?: Array<string>,
/**
 * Other nodes in its radio group (sharing modem settings): everyone
 * reachable through chains of radio contact, not only its own contacts.
 */
group: number,
/**
 * Nodes it heard or was heard by itself, over the air.
 */
direct: number,
/**
 * Presets and how many group members each, when they disagree.
 */
conflict?: Array<[string, number]>, };

export type Radio = { heard_as: Array<HeardAs>, reported?: Reported,
/**
 * Channels it was seen on (D-064).
 */
channels?: Array<ChannelUse>,
/**
 * Its modem preset as far as the window shows (D-064).
 */
preset?: PresetGuess,
/**
 * As a gateway: the MQTT topic roots it uplinked under (D-090).
 */
uplink_topics?: Array<TopicUse>, };

export type Reach = { origin: string,
/**
 * The hop limit its own packets were sent with (most common in the window).
 */
hop_start?: number,
/**
 * Internet (MQTT) links were followed too.
 */
internet: boolean, nodes: Array<Reached>, };

export type Reached = { id: string,
/**
 * The smallest hop limit at which this node receives the packet.
 */
need: number,
/**
 * The transmitter it hears it from at that hop limit.
 */
via: string,
/**
 * The hop into it is a 0-cost link (it relays onwards for free).
 */
free?: boolean, };

export type RegionSummary = { name: string,
/**
 * Nodes placed in it (a reported position or an estimate), and their ids.
 */
nodes: number, members: Array<string>, routers: number, bases: number, gateways: number,
/**
 * Distinct senders and gateways of rows uplinked under a topic root naming it.
 */
topic_nodes: number, topic_gateways: number,
/**
 * The median of its nodes' median channel utilisation, and how many reported one.
 */
ch_util?: number, ch_util_nodes: number,
/**
 * The node reporting the busiest channel, and its median.
 */
busiest?: [string, number],
/**
 * Its nodes heard in the window by role, hardware, preset and firmware (D-196).
 */
fleet: Fleet, };

export type RegionsView = {
/**
 * The outlines are in: false until the worker has handed them over.
 */
loaded: boolean, regions: Array<RegionSummary>,
/**
 * Placed nodes outside every region (abroad, or far out at sea).
 */
outside: number, };

/**
 * A reported position the radio rules out (D-178): a gateway heard the
 * packet carrying it directly, at a signal too strong for the distance
 * between them.
 */
export type RejectedPosition = {
/**
 * The gateway whose direct reception contradicts it most.
 */
gateway: string, rssi: number, distance_m: number,
/**
 * The farthest that signal can have come from (graph::max_distance_m).
 */
bound_m: number, lat: number, lon: number, alt?: number, precision_bits: number, precision_known: boolean, signature: 'verified' | 'unsigned' | 'unverifiable' | 'not-applicable', observed_at: string, source: 'position' | 'mapreport', };

export type RelayedPacket = { lp: string, at: string, origin: string, type: string, to?: string, evidence: Array<'relay_byte' | 'traceroute'>,
/**
 * How many gateways heard its rebroadcast.
 */
gateways: number, };

export type Relaying = {
/**
 * Packets it received with hops left, where a witness gateway uplinked them.
 */
expected: number,
/**
 * Of those, packets whose rebroadcast by it was reported.
 */
seen: number,
/**
 * Gateways that hear it directly (its witnesses).
 */
witnesses: number,
/**
 * Of `expected`, packets it uplinked itself (certain receptions); the
 * rest are inferred from a strong link to the transmitter.
 */
received_as_gateway: number, };

/**
 * Routing packets from one node answering a packet: ACKs or one error.
 */
export type Reply = { from: string, kind: string, error?: string,
/**
 * Distinct routing packets (a sender that retries gets each copy answered).
 */
count: number, };

/**
 * The node's own map report (exact).
 */
export type Reported = { region?: string, modem_preset?: string,
/**
 * The preset is confirmed in use (has_default_channel). Without it the
 * node may run a custom modem config: firmware still reports the stored
 * preset, LONG_FAST unless changed.
 */
preset_confirmed?: boolean, at: string, };

export type RouteSegment = { a: string, b: string, dashed: boolean, why: 'direct' | 'traceroute' | 'relay' | 'gap' | 'unknown_relay' | 'internet' | 'delivered',
/**
 * A traceroute's way there ("forward": the request, requester to
 * target) or back ("back": the reply, target to requester).
 */
leg?: 'forward' | 'back', };

/**
 * A router's link quality over the window (D-197): per time bin, the
 * median SNR of its radio links to other routers and the readings it
 * rests on, in both directions.
 */
export type RouterQuality = {
/**
 * Bin width, ms; bins start at the window's start.
 */
bin_ms: number,
/**
 * Its transmissions as other routers heard them: [bin middle (Unix
 * ms), median SNR (dB), readings], bins with readings only.
 */
heard: Array<[number, number, number]>,
/**
 * Other routers as it heard them.
 */
hearing: Array<[number, number, number]>,
/**
 * The noise floor it measures (D-199): [bin middle, median dBm,
 * readings], bins with readings only; empty when it sends none.
 */
floor?: Array<[number, number, number]>, };

export type Signatures = { verified: number, unsigned: number, unverifiable: number, not_applicable: number, };

export type Snapshot = { nodes: Array<MeshNode>, edges: Array<Edge>, edges_truncated: boolean, counts: Counts, };

export type Stats = { n: number, median?: number, min?: number, max?: number, last?: number, };

/**
 * A status text the node broadcast (NODE_STATUS_APP), and when (D-103).
 */
export type StatusText = { status: string, at: string, };

/**
 * One node's store-and-forward traffic (D-103).
 */
export type StoreForwardNode = { node: string, packets: number,
/**
 * Share of the window's estimated airtime (its packets with rebroadcasts).
 */
share: number,
/**
 * Packets by message kind, most first.
 */
by_kind: Array<[string, number]>, heartbeats_per_hour: number,
/**
 * History replays (router_text_*): count and text bytes.
 */
replays: number, replay_bytes: number, };

/**
 * Store-and-forward's part of the airtime (D-103).
 */
export type StoreForwardStats = { packets: number, share: number,
/**
 * Packets and airtime share by message kind, most airtime first.
 */
by_kind: Array<[string, number, number]>, nodes: Array<StoreForwardNode>, };

export type Telemetry = { battery?: number, voltage?: number, ch_util?: number, air_util?: number, uptime?: number, observed_at: string, };

export type TelemetrySample = { at: string, battery?: number, voltage?: number, ch_util?: number, air_util?: number, uptime?: number, };

/**
 * A topic root a gateway uplinked under: distinct receptions and the last one.
 */
export type TopicUse = { topic: string, regions: Array<string>, receptions: number, last_at: string, };

export type TrackPoint = { lat: number, lon: number, alt?: number, at: string, };

export type Traffic = { bucket: string, buckets: Array<Bucket>, packets: number, receptions: number, };

export type Watched = { id: string,
/**
 * observed, referenced (only named by others) or absent (not in the window).
 */
status: 'observed' | 'referenced' | 'absent', long_name?: string, short_name?: string, role?: string, last_seen?: string,
/**
 * Time from it was last heard to the newest data in the window (ms).
 */
quiet_ms?: number,
/**
 * Its median gap between transmissions or uplinks (ms), when known.
 */
usual_gap_ms?: number,
/**
 * Quiet for much longer than usual (see QUIET_MIN_MS).
 */
quiet: boolean, battery?: number, voltage?: number, telemetry_at?: string, packets: number,
/**
 * Distinct gateways that got its packets.
 */
gateways: number, is_gateway: boolean, };

/**
 * Evidence for one directed link U -> R (R relays what it heard from U).
 */
export type ZeroCost = {
/**
 * Packets R rebroadcast with U's hop limit (no hop spent).
 */
free: number,
/**
 * Packets R rebroadcast with one hop less than U sent.
 */
spent: number,
/**
 * Enough consistent evidence to call the link 0-cost.
 */
likely: boolean, };
