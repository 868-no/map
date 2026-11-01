import { describe, expect, it } from 'vitest'
import { fromQuery, nodeLink, toQuery, defaultFilters } from '../src/state/store'

describe('permanent node links (D-080)', () => {
  it('links to the node alone', () => {
    expect(nodeLink('!8278b930', 'https://map.868.no')).toBe('https://map.868.no/?node=!8278b930')
  })
  it('selects the linked node, and puts the selected node in the URL', () => {
    expect(fromQuery(new URLSearchParams('node=!8278B930')).selection).toEqual({ kind: 'node', id: '!8278b930' })
    expect(fromQuery(new URLSearchParams('node=garbage')).selection).toBeUndefined()
    const win = { live: true, durationH: 72, start: null, end: null }
    expect(toQuery({ win, filters: defaultFilters, selection: { kind: 'node', id: '!8278b930' } }).toString()).toBe('node=%218278b930')
    expect(toQuery({ win, filters: defaultFilters, selection: null }).toString()).toBe('')
  })
})
