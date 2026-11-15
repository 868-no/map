import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TimeChart } from '../src/components/TimeChart'
import { precipClasses } from '../src/state/weather'

afterEach(cleanup)

const H = 3_600_000

describe('precipitation coloured by its likely form (D-216)', () => {
  it('sorts hours into rain, sleet and snow by air temperature', () => {
    const cs = precipClasses([[H, 5], [2 * H, 2], [3 * H, 0.5], [4 * H, 0], [5 * H, -3]])
    expect(cs.map((c) => [c.label, [...c.times]])).toEqual([
      ['Rain', [H]],
      ['Sleet', [2 * H, 3 * H]],
      ['Snow', [4 * H, 5 * H]],
    ])
  })

  it('draws each form in its own flat colour, grey without a temperature, and names only the forms shown', () => {
    const band = { label: 'Precipitation', unit: 'mm', color: 'grey', kind: 'amount' as const, points: [[H, 1], [2 * H, 2], [3 * H, 0.5], [4 * H, 0]] as [number, number][],
      classes: precipClasses([[H, 4], [2 * H, -1], [4 * H, 6]]) }
    const { container } = render(<TimeChart label="SNR" unit="dB" start={0} end={4 * H} series={[{ label: 'a', color: 'red', points: [[H, 3]] }]} bands={[band]} />)
    const fills = [...container.querySelectorAll('path.tchart-band.amount')].map((p) => (p as SVGPathElement).style.fill)
    expect(fills).toEqual(['var(--precip-rain)', 'var(--precip-snow)', 'grey'])
    // The dry hour at 4 h is rain-warm but draws no bar, so Sleet is absent and Rain shown only for the hour at 1 h.
    expect([...container.querySelectorAll('.tchart-legend span')].map((s) => s.textContent)).toEqual(['Rain > 2 °C', 'Snow ≤ 0 °C'])
  })
})
