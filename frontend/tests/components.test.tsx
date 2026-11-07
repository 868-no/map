import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BarChart } from '../src/components/BarChart'
import { SettingsPanel } from '../src/features/menu'
import { DEFAULT_MAX_NODES, MAX_NODES_RANGE, useStore } from '../src/state/store'

afterEach(cleanup)

describe('BarChart', () => {
  const bars = [{ label: 'week 1', value: 10, part: 2 }, { label: 'week 2', value: 1500, part: 40 }, { label: 'week 3', value: 30, part: 3 }]

  it('reads out the newest bar until another is hovered', () => {
    const { container } = render(<BarChart title="Nodes heard" partLabel="new" bars={bars} />)
    const read = container.querySelector('.tchart-read')!
    expect(read.textContent).toContain('30')
    expect(read.textContent).toContain('3 new')
    expect(read.textContent).toContain('week 3')
    fireEvent.pointerEnter(container.querySelectorAll('svg g')[1])
    expect(read.textContent).toContain((1500).toLocaleString())
    expect(read.textContent).toContain('week 2')
    fireEvent.pointerLeave(container.querySelector('.bchart-plot')!)
    expect(read.textContent).toContain('week 3')
  })

  it('names every bar for screen readers, and draws nothing without bars', () => {
    render(<BarChart title="Gateways" bars={bars} />)
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Gateways: week 1 10, week 2 1500, week 3 30')
    cleanup()
    const { container } = render(<BarChart title="Gateways" bars={[]} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('Settings: nodes on the map (D-182)', () => {
  afterEach(() => useStore.getState().setToggles({ maxNodes: DEFAULT_MAX_NODES }))

  it('applies a value when the field is left, clamped to the range, and offers the default back', () => {
    render(<SettingsPanel canInstall={false} install={() => {}} />)
    const field = screen.getByRole('spinbutton', { name: 'Nodes on the map' })
    fireEvent.change(field, { target: { value: '12' } })
    expect(useStore.getState().toggles.maxNodes).toBe(DEFAULT_MAX_NODES) // not until committed
    fireEvent.blur(field)
    expect(useStore.getState().toggles.maxNodes).toBe(MAX_NODES_RANGE[0])
    expect((field as HTMLInputElement).value).toBe(String(MAX_NODES_RANGE[0]))
    fireEvent.change(field, { target: { value: 'many' } })
    fireEvent.blur(field)
    expect(useStore.getState().toggles.maxNodes).toBe(MAX_NODES_RANGE[0]) // nonsense is dropped
    fireEvent.click(screen.getByRole('button', { name: `Reset to ${DEFAULT_MAX_NODES.toLocaleString('en')}` }))
    expect(useStore.getState().toggles.maxNodes).toBe(DEFAULT_MAX_NODES)
    expect((field as HTMLInputElement).value).toBe(String(DEFAULT_MAX_NODES)) // the field follows a change from elsewhere
  })

  it('names watched nodes among what Reset forgets', () => {
    render(<SettingsPanel canInstall={false} install={() => {}} />)
    expect(screen.getByText(/Forget everything this site stored/).textContent).toContain('watched nodes')
  })
})
