// A node's long-term history (D-195): the server's day, week or month
// buckets of it, as the History section shows them.
import type { components } from '../../api/schema'

export type NodeTrends = components['schemas']['NodeTrendsBody']
type Bucket = components['schemas']['NodeTrendBucket']

export interface HistoryRow {
  start: string
  hours: number // hours in which anything was logged
  heard: number // of them, hours it sent anything in
  /** Heard hours as a whole percentage of logged ones; null when nothing was logged. */
  heardPct: number | null
  gatewayPct: number | null
  gateway: number
  packets: number
  receptions: number
  /** Gateways per packet, to one decimal; null without packets. */
  perPacket: number | null
  /** Lowest battery level (%); null when none was reported, or only external power. */
  battery: number | null
  batteryText: string // "62 %", "external power" or "no report"
}

const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : null)

/** Firmware reports battery level 101 on external power. */
function batteryText(v: number | undefined): string {
  if (v === undefined) return 'no report'
  return v > 100 ? 'external power' : `${Math.round(v)} %`
}

export function historyRows(buckets: readonly Bucket[]): HistoryRow[] {
  return buckets.map((b) => ({
    start: b.start,
    hours: b.hours,
    heard: b.hours_heard,
    heardPct: pct(b.hours_heard, b.hours),
    gateway: b.hours_gateway,
    gatewayPct: pct(b.hours_gateway, b.hours),
    packets: b.packets,
    receptions: b.receptions,
    perPacket: b.receptions_per_packet === undefined ? null : Math.round(b.receptions_per_packet * 10) / 10,
    battery: b.battery_min !== undefined && b.battery_min <= 100 ? b.battery_min : null,
    batteryText: batteryText(b.battery_min),
  }))
}
