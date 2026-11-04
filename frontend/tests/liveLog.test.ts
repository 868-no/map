import { beforeEach, describe, expect, it } from 'vitest'
import type { ObsRow } from '../src/api/types'
import { LIVE_LOG_MS, nodeId, useLiveLog } from '../src/state/liveLog'

const row = (l: string, s: number, t: number, extra: Partial<ObsRow> = {}) => ({ i: 1, t, b: 'x', s, y: 'telemetry', l, o: l, sg: 'unsigned', ...extra }) as unknown as ObsRow

describe('live packet log', () => {
  beforeEach(() => useLiveLog.getState().clear())

  it('keeps one row per packet, with node ids and broadcast as the log shows them', () => {
    const now = Date.now()
    useLiveLog.getState().addRows([row('aa', 0x1, now, { d: 0xffffffff } as Partial<ObsRow>), row('aa', 0x1, now + 5), row('bb', 0x2, now, { d: 0x672f1873, y: 'routing' } as Partial<ObsRow>)])
    expect(useLiveLog.getState().rows).toEqual([
      { lp: 'aa', t: now, src: '!00000001', dst: 'broadcast', type: 'telemetry' },
      { lp: 'bb', t: now, src: '!00000002', dst: '!672f1873', type: 'routing' },
    ])
    expect(nodeId(0x672f1873)).toBe('!672f1873')
  })

  it('takes relays from live rebroadcasts only, and forgets them after a while', () => {
    const t = 1_000_000
    useLiveLog.getState().addTransmissions([
      { key: 'aa|!00000003', tx: '!00000003', rebroadcast: true },
      { key: 'aa|!00000001', tx: '!00000001', rebroadcast: false }, // the originator
      { key: 'rqx|!00000004', tx: '!00000004', rebroadcast: true, replay: true }, // a replayed route
      { key: 'bb|!00000005|delivered', tx: '!00000005', rebroadcast: false, delivered: true },
    ], t)
    expect(useLiveLog.getState().relays).toEqual([{ lp: 'aa', tx: '!00000003', at: t }])
    useLiveLog.getState().addTransmissions([{ key: 'cc|!00000006', tx: '!00000006', rebroadcast: true }], t + LIVE_LOG_MS + 1)
    expect(useLiveLog.getState().relays.map((r) => r.lp)).toEqual(['cc'])
  })
})
