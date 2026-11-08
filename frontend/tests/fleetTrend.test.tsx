import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { components } from '../src/api/schema'
import { StackedBarChart, percent } from '../src/components/StackedBarChart'
import { fleetStacks } from '../src/features/fleetTrend'

afterEach(cleanup)

type Body = components['schemas']['FleetTrendsBody']

const body: Body = {
  bucket: 'week',
  firmware: { values: [
    { name: '2.7', kind: 'value', basis: 'reported' },
    { name: '2.6', kind: 'value', basis: 'reported' },
    { name: 'others', kind: 'others', folded: 3 },
    { name: 'hardware', kind: 'value', basis: 'hardware' },
    { name: 'unknown', kind: 'unknown' },
  ] },
  hardware: { values: [{ name: 'HELTEC_V3', kind: 'value' }, { name: 'T_ECHO', kind: 'value' }, { name: 'unknown', kind: 'unknown' }] },
  role: { values: [{ name: 'CLIENT_BASE', kind: 'value' }] },
  preset: { values: [] },
  buckets: [
    { start: '2026-11-02T00:00:00+01:00', nodes: 10, firmware: [2, 1, 1, 4, 2], hardware: [5, 3, 2], role: [10], preset: [] },
    { start: '2026-11-09T00:00:00+01:00', nodes: 4, firmware: [3, 0, 0, 1, 0], hardware: [1, 1, 2], role: [4], preset: null },
  ],
}

describe('fleet trend series (D-198)', () => {
  it('labels firmware as the Regions panel does, inferred generations in their own fixed colours', () => {
    const { series, stacks } = fleetStacks(body, 'firmware')
    expect(series.map((s) => s.label)).toEqual(['2.7', '2.6', '3 others', '2.7 or earlier (inferred)', 'unknown'])
    expect(series.map((s) => s.color)).toEqual(['var(--series-1)', 'var(--series-2)', 'var(--series-others)', 'var(--series-7)', 'var(--series-unknown)'])
    expect(series[0].title).toContain('map reports state it')
    expect(series[3].title).toContain('announces a public key')
    expect(stacks).toEqual([{ start: body.buckets![0].start, total: 10, counts: [2, 1, 1, 4, 2] }, { start: body.buckets![1].start, total: 4, counts: [3, 0, 0, 1, 0] }])
  })

  it('names hardware and roles readably, and copes with a dimension without values', () => {
    expect(fleetStacks(body, 'hardware').series.map((s) => s.label)).toEqual(['Heltec V3', 'LilyGO T-Echo', 'unknown'])
    expect(fleetStacks(body, 'role').series[0]).toMatchObject({ label: 'Client base', title: 'CLIENT_BASE', color: 'var(--series-1)' })
    const p = fleetStacks(body, 'preset')
    expect(p.series).toEqual([])
    expect(p.stacks[1].counts).toEqual([])
    expect(fleetStacks(undefined, 'role')).toEqual({ series: [], stacks: [] })
  })

  it('rounds shares, never a non-zero one to nothing', () => {
    expect([percent(1, 3), percent(1, 400), percent(0, 4), percent(2, 0)]).toEqual(['33 %', '<1 %', '0 %', '0 %'])
  })
})

describe('StackedBarChart', () => {
  const { series, stacks } = fleetStacks(body, 'hardware')
  const bars = stacks.map((s, i) => ({ label: `week ${i + 1}`, total: s.total, counts: s.counts }))

  it('stacks each period to the full height, first series on top, and reads out the hovered one in the legend', () => {
    const { container } = render(<StackedBarChart title="Hardware" unit={['node', 'nodes']} series={series} bars={bars} />)
    const col = container.querySelectorAll('g.schart-col')[0]
    const segs = [...col.querySelectorAll('rect.schart-seg')].map((r) => [Number(r.getAttribute('y')), Number(r.getAttribute('height'))])
    expect(segs).toEqual([[0, 50], [50, 30], [80, 20]])
    const legend = () => [...container.querySelectorAll('.schart-legend li')].map((li) => li.textContent)
    expect(container.querySelector('.tchart-read')!.textContent).toContain('4 nodes')
    expect(legend()).toEqual(['Heltec V31' + '25 %', 'LilyGO T-Echo1' + '25 %', 'unknown2' + '50 %'])
    fireEvent.pointerEnter(col)
    expect(container.querySelector('.tchart-read')!.textContent).toContain('10 nodes')
    expect(legend()[0]).toBe('Heltec V35' + '50 %')
    expect(container.querySelectorAll('g.schart-col.dim')).toHaveLength(1)
    expect(container.querySelector('svg')!.getAttribute('aria-label')).toContain('week 1: Heltec V3 50 %, LilyGO T-Echo 30 %, unknown 20 %')
  })

  it('draws nothing without bars or series', () => {
    const { container } = render(<StackedBarChart title="Preset" unit={['node', 'nodes']} series={[]} bars={bars} />)
    expect(container.innerHTML).toBe('')
  })
})
