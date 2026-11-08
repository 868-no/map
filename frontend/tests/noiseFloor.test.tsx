import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TimeChart } from '../src/components/TimeChart'
import { linkFloorSeries } from '../src/features/noiseFloor'
import { routerFloorAxis, routerLinkSeries } from '../src/features/node/routerLinks'

afterEach(cleanup)

const H = 3_600_000

describe('noise floor lines (D-199)', () => {
  it('draws a dashed line for each end of a link that measures its floor, in the colour of what it receives', () => {
    const lines = linkFloorSeries({ floor_a: [[H, -104], [2 * H, -101]], floor_b: [[H, -97]] }, 'A', 'B')
    expect(lines.map((l) => [l.label, l.color, l.dashed])).toEqual([
      ['Noise floor at B', 'var(--accent)', true],
      ['Noise floor at A', 'var(--warn)', true],
    ])
    expect(lines[1].points).toEqual([[H, -104], [2 * H, -101]])
    expect(linkFloorSeries({ floor_b: [[H, -97]] }, 'A', 'B').map((l) => l.label)).toEqual(['Noise floor at B'])
    expect(linkFloorSeries({}, 'A', 'B')).toEqual([])
  })

  it("puts a router's binned floor on a dBm axis of its own, and none without readings", () => {
    const q = { bin_ms: H, heard: [[0.5 * H, 9.5, 12]] as [number, number, number][], hearing: [[0.5 * H, 6, 3]] as [number, number, number][] }
    expect(routerFloorAxis(q)).toBeUndefined()
    const axis = routerFloorAxis({ ...q, floor: [[0.5 * H, -106.5, 2], [1.5 * H, -99, 1]] })!
    expect(axis.unit).toBe('dBm')
    expect(axis.series[0].points).toEqual([[0.5 * H, -106.5], [1.5 * H, -99]])
    expect(axis.series[0].counts?.get(1.5 * H)).toBe(1)
  })

  it('reads the right-hand scale in its own unit and keeps the latest readout on the chart’s own lines', () => {
    const q = { bin_ms: H, heard: [[0.5 * H, 9.5, 12], [1.5 * H, 1, 4]] as [number, number, number][], hearing: [] as [number, number, number][], floor: [[0.5 * H, -110, 2], [1.9 * H, -100, 1]] as [number, number, number][] }
    const { container } = render(<TimeChart label="SNR" unit="dB" start={0} end={2 * H} series={routerLinkSeries(q)} right={routerFloorAxis(q)} />)
    expect(container.querySelector('.tchart-read')!.textContent).toContain('1.0 dB')
    const right = [...container.querySelectorAll('.tchart-y.band')].map((e) => e.textContent)
    expect(right).toEqual(['-99 dBm', '-111 dBm'])
    expect(container.querySelectorAll('.tchart-line.dashed')).toHaveLength(1)
    expect(container.querySelector('.tchart-legend')!.textContent).toContain('Its noise floor (dBm, right) (3 readings)')
    expect(container.querySelector('svg')!.getAttribute('aria-label')).toContain('Its noise floor on a scale of its own from -110 dBm to -100 dBm')
  })

  it('draws nothing for right-hand lines alone', () => {
    const { container } = render(<TimeChart label="SNR" unit="dB" start={0} end={H} series={[]} right={{ unit: 'dBm', series: [{ label: 'f', color: 'red', points: [[1, -100]] }] }} />)
    expect(container.querySelector('svg')).toBeNull()
  })
})
