import { describe, expect, it } from 'vitest'
import { historyRows } from '../src/features/node/historyRows'
import { periodLabels } from '../src/lib/periods'

describe('node history rows (D-195)', () => {
  const bucket = (o: Partial<Parameters<typeof historyRows>[0][number]>) => ({ start: '2026-11-02T00:00:00+01:00', hours: 0, hours_heard: 0, hours_gateway: 0, packets: 0, receptions: 0, ...o })

  it('turns hours into shares of logged hours, and rounds gateways per packet', () => {
    const [r] = historyRows([bucket({ hours: 168, hours_heard: 84, hours_gateway: 42, packets: 300, receptions: 701, receptions_per_packet: 701 / 300 })])
    expect(r.heardPct).toBe(50)
    expect(r.gatewayPct).toBe(25)
    expect(r.perPacket).toBe(2.3)
  })

  it('has no share or ratio for a bucket with nothing logged or no packets', () => {
    const [r] = historyRows([bucket({})])
    expect(r.heardPct).toBeNull()
    expect(r.gatewayPct).toBeNull()
    expect(r.perPacket).toBeNull()
  })

  it('reads battery level 101 as external power, never as a level', () => {
    const [low, powered, none] = historyRows([bucket({ battery_min: 37 }), bucket({ battery_min: 101 }), bucket({})])
    expect([low.battery, low.batteryText]).toEqual([37, '37 %'])
    expect([powered.battery, powered.batteryText]).toEqual([null, 'external power'])
    expect([none.battery, none.batteryText]).toEqual([null, 'no report'])
  })
})

describe('period labels', () => {
  it('names weeks by their Monday and months by month, in the zone asked for', () => {
    const [w] = periodLabels(['2026-11-01T23:00:00Z'], 'week', 'Europe/Oslo')
    expect(w).toMatch(/^week of /)
    expect(w).toContain('2')
    const [m] = periodLabels(['2026-10-31T23:00:00Z'], 'month', 'Europe/Oslo')
    expect(m).toMatch(/Nov/)
  })
})
