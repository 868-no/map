import { beforeEach, describe, expect, it } from 'vitest'
import type { Issue, Watched } from '../src/derive/views'
import { useWatch, watchChanges } from '../src/state/watch'

const w = (over: Partial<Watched>): Watched => ({ id: '!0000000a', status: 'observed', quiet: false, packets: 5, gateways: 2, is_gateway: false, ...over })
const issue = (kind: string, severity: Issue['severity']): Issue => ({ node: '!0000000a', kind, severity, summary: `${kind} summary`, detail: '' })

describe('watchlist notifications (D-192)', () => {
  it('says what changed since the last update, and nothing on the first', () => {
    expect(watchChanges(undefined, w({ quiet: true, quiet_ms: 5 * 3_600_000 }), [issue('silent', 'warning')], new Set())).toEqual([])
    expect(watchChanges(w({}), w({ quiet: true, quiet_ms: 5 * 3_600_000, usual_gap_ms: 30 * 60_000 }), [], new Set())).toEqual(['Not heard for 5.0 h; it is usually heard every 30 min.'])
    expect(watchChanges(w({ quiet: true }), w({}), [], new Set())).toEqual(['Heard again.'])
    expect(watchChanges(w({ battery: 40 }), w({ battery: 18 }), [], new Set())).toEqual(['Battery down to 18 %.'])
    expect(watchChanges(w({ battery: 18 }), w({ battery: 17 }), [], new Set())).toEqual([]) // already low
  })

  it('notifies of new problems and warnings, not notices or ones already seen', () => {
    const seen = new Set(['channel_busy|!0000000a'])
    const got = watchChanges(w({}), w({}), [issue('channel_busy', 'problem'), issue('battery_falling', 'warning'), issue('duplicate_name', 'notice')], seen)
    expect(got).toEqual(['Warning: battery_falling summary.'])
  })
})

describe('the watchlist across tabs (D-192)', () => {
  const KEY = 'meshmap.watch'
  const stored = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as { ids: string[]; notify: boolean } | null
  /** Another tab saving the list: it writes storage, and this tab gets a storage event. */
  const otherTab = (v: { ids: string[]; notify: boolean } | null) => {
    if (v) localStorage.setItem(KEY, JSON.stringify(v))
    else localStorage.clear()
    window.dispatchEvent(new StorageEvent('storage', { key: v ? KEY : null }))
  }
  beforeEach(() => {
    localStorage.clear()
    useWatch.setState({ ids: [], notify: false })
  })

  it('keeps what another tab added when this one changes the list', () => {
    useWatch.getState().toggle('!0000000a')
    localStorage.setItem(KEY, JSON.stringify({ ids: ['!0000000a', '!0000000b'], notify: true })) // no event yet
    useWatch.getState().toggle('!0000000c')
    expect(stored()).toEqual({ ids: ['!0000000a', '!0000000b', '!0000000c'], notify: true })
    expect(useWatch.getState().ids).toEqual(['!0000000a', '!0000000b', '!0000000c'])
    useWatch.getState().setNotify(false)
    expect(stored()).toEqual({ ids: ['!0000000a', '!0000000b', '!0000000c'], notify: false })
  })

  it("takes up another tab's save at once, and its reset", () => {
    otherTab({ ids: ['!0000000d'], notify: true })
    expect(useWatch.getState()).toMatchObject({ ids: ['!0000000d'], notify: true })
    window.dispatchEvent(new StorageEvent('storage', { key: 'meshmap.other' }))
    expect(useWatch.getState().ids).toEqual(['!0000000d'])
    otherTab(null)
    expect(useWatch.getState()).toMatchObject({ ids: [], notify: false })
  })

  it('drops ids that are not node ids, and starts empty from a corrupt entry', () => {
    otherTab({ ids: ['!0000000a', 'nope', '!XYZ'], notify: false })
    expect(useWatch.getState().ids).toEqual(['!0000000a'])
    localStorage.setItem(KEY, '{not json')
    useWatch.getState().toggle('!0000000b')
    expect(stored()).toEqual({ ids: ['!0000000b'], notify: false })
  })
})
