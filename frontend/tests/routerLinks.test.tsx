import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TimeChart } from '../src/components/TimeChart'
import { binWords, routerLinkSeries } from '../src/features/node/routerLinks'

afterEach(cleanup)

const H = 3_600_000
const q = { bin_ms: H, heard: [[0.5 * H, 9.5, 12], [1.5 * H, 1, 4]] as [number, number, number][], hearing: [[0.5 * H, 6, 3]] as [number, number, number][] }

describe('router link quality chart (D-197)', () => {
  it('turns the binned medians into two lines that keep their readings', () => {
    const [heard, hearing] = routerLinkSeries(q)
    expect(heard.label).toBe('Heard by other routers')
    expect(heard.points).toEqual([[0.5 * H, 9.5], [1.5 * H, 1]])
    expect(heard.counts?.get(1.5 * H)).toBe(4)
    expect(hearing.points).toEqual([[0.5 * H, 6]])
  })

  it('names bin widths', () => {
    expect(binWords(900_000)).toBe('15 min')
    expect(binWords(H)).toBe('1 h')
    expect(binWords(6 * H)).toBe('6 h')
  })

  it('reads out the readings behind the latest bin and sums them in the legend', () => {
    const { container } = render(<TimeChart label="SNR" unit="dB" start={0} end={2 * H} series={routerLinkSeries(q)} />)
    expect(container.querySelector('.tchart-read')!.textContent).toContain('1.0 dB · 4 readings')
    const legend = container.querySelector('.tchart-legend')!.textContent
    expect(legend).toContain('Heard by other routers (16 readings)')
    expect(legend).toContain('Hearing other routers (3 readings)')
  })
})
