import { describe, expect, it } from 'vitest'
import type { Issue, Watched } from '../src/derive/views'
import { watchChanges } from '../src/state/watch'

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
