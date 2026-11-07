import { describe, expect, it } from 'vitest'
import { Abandoned, abandonable, cursorMs, DAY_MS, dayName, limiter, planDays, rangeEnd, requestedRange, settleFirst, sliceBounds } from '../src/derive/slices'

describe('range fetch arithmetic', () => {
  it('reads a cursor as the millisecond it starts at', () => {
    expect(cursorMs('1761782400123456.42')).toBe(1761782400123)
    expect(cursorMs('1761782400123999.1')).toBe(1761782400123) // µs floor to ms
    expect(cursorMs(undefined)).toBe(0)
  })

  it('ends at the window end or an earlier until', () => {
    expect(rangeEnd('2026-10-30T12:00:00Z', null)).toBe(Date.parse('2026-10-30T12:00:00Z'))
    expect(rangeEnd('2026-10-30T12:00:00Z', '2026-10-30T06:00:00Z')).toBe(Date.parse('2026-10-30T06:00:00Z'))
    expect(rangeEnd('2026-10-30T12:00:00Z', '2026-10-31T00:00:00Z')).toBe(Date.parse('2026-10-30T12:00:00Z'))
  })

  it('splits evenly into contiguous slices that end exactly at hi', () => {
    expect(sliceBounds(0, 100, 4)).toEqual([0, 25, 50, 75, 100])
    const b = sliceBounds(1000, 1103, 4) // uneven: steps round up, the last slice is shorter
    expect(b).toEqual([1000, 1026, 1052, 1078, 1103])
    for (let k = 1; k < b.length; k++) expect(b[k]).toBeGreaterThan(b[k - 1])
  })

  it('leaves trailing slices empty for very short ranges', () => {
    expect(sliceBounds(10, 12, 4)).toEqual([10, 11, 12, 12, 12])
    expect(sliceBounds(10, 10, 4)).toEqual([10, 10, 10, 10, 10])
  })
})

describe('whole-day planning (D-158)', () => {
  const t = (s: string) => Date.parse(s)
  const names = (days: number[]) => days.map(dayName)

  it('estimates the requested range from the parameters', () => {
    const now = t('2026-11-05T14:00:00Z')
    expect(requestedRange(new URLSearchParams({ duration: '72h' }), now)).toEqual({ lo: t('2026-11-02T14:00:00Z'), hi: now })
    expect(requestedRange(new URLSearchParams({ duration: '72h', since: '2026-11-05T13:00:00Z' }), now)).toEqual({ lo: t('2026-11-05T13:00:00Z'), hi: now })
    expect(requestedRange(new URLSearchParams({ start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z', until: '2026-10-04T06:00:00Z' }), now))
      .toEqual({ lo: t('2026-10-01T00:00:00Z'), hi: t('2026-10-04T06:00:00Z') })
    expect(requestedRange(new URLSearchParams({ duration: 'soon' }), now).lo).toBeNaN()
  })

  it('takes every settled day a rolling window touches, whole', () => {
    // 72 h at 14:00: Nov 2 from 14:00 is needed, all of it is fetched; Nov 5 is today.
    expect(names(planDays(t('2026-11-02T14:00:00Z'), t('2026-11-05T14:00:00Z'), t('2026-11-05T14:00:00Z')))).toEqual(['2026-11-02', '2026-11-03', '2026-11-04'])
    // At 20:00 only 4 h of Nov 2 are needed: the day still comes whole.
    expect(names(planDays(t('2026-11-02T20:00:00Z'), t('2026-11-05T20:00:00Z'), t('2026-11-05T20:00:00Z')))).toEqual(['2026-11-02', '2026-11-03', '2026-11-04'])
  })

  it('waits for a day to settle', () => {
    const lo = t('2026-11-03T00:00:00Z')
    expect(names(planDays(lo, t('2026-11-05T00:20:00Z'), t('2026-11-05T00:20:00Z')))).toEqual(['2026-11-03'])
    expect(names(planDays(lo, t('2026-11-05T00:30:00Z'), t('2026-11-05T00:30:00Z')))).toEqual(['2026-11-03', '2026-11-04'])
  })

  it('takes past days whole however little of them is needed, and never a day not settled', () => {
    const now = t('2026-11-05T12:00:00Z')
    // A fixed window ending mid-day: its last day comes whole too.
    expect(names(planDays(t('2026-10-01T00:00:00Z'), t('2026-10-03T06:00:00Z'), now))).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    // A window inside one past day: that day.
    expect(names(planDays(t('2026-10-01T12:00:00Z'), t('2026-10-01T18:00:00Z'), now))).toEqual(['2026-10-01'])
    expect(planDays(t('2026-11-05T01:00:00Z'), now, now)).toEqual([]) // today
    expect(names(planDays(t('2026-11-04T23:00:00Z'), t('2026-11-05T01:00:00Z'), now))).toEqual(['2026-11-04']) // a 2-hour window: yesterday whole, today paged
    expect(planDays(NaN, now, now)).toEqual([])
    expect(planDays(now, now, now)).toEqual([])
  })

  it('names days in UTC', () => {
    expect(dayName(t('2026-11-03T23:59:59.999Z'))).toBe('2026-11-03')
    expect(dayName(t('2026-11-03T00:00:00Z') + DAY_MS)).toBe('2026-11-04')
  })

  it('limits requests in flight', async () => {
    const run = limiter(2)
    let active = 0
    let peak = 0
    const order: number[] = []
    const job = (k: number, ms: number) => run(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, ms))
      active--
      order.push(k)
      if (k === 3) throw new Error('fails')
      return k
    })
    const results = await Promise.allSettled([job(1, 20), job(2, 5), job(3, 5), job(4, 5), job(5, 5)])
    expect(peak).toBe(2)
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
    expect(order.sort()).toEqual([1, 2, 3, 4, 5])
  })
})

describe('a failing range', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('reports the first failure in time, not a task abandoned after it', async () => {
    let failed = false
    const moved = new Error('409: the server changed generation')
    const tasks = [
      // Listed first, but it stops only at its next page, after the day failed.
      async () => {
        await tick()
        await tick()
        if (failed) throw new Abandoned('range abandoned')
      },
      async () => {
        await tick()
        throw moved
      },
      async () => {
        await tick()
        await tick()
        await tick()
        throw new Error('a later failure')
      },
    ]
    const err = await settleFirst(tasks, () => (failed = true))
    expect(failed).toBe(true)
    expect(err?.reason).toBe(moved)
  })

  it('resolves null when every task succeeds', async () => {
    let failed = false
    expect(await settleFirst([async () => 1, async () => 2], () => (failed = true))).toBeNull()
    expect(failed).toBe(false)
  })

  it('does not make a request that was waiting for its slot when the range failed', async () => {
    let failed = false
    const run = abandonable(limiter(1), () => failed)
    const made: string[] = []
    const first = run(async () => {
      made.push('first')
      await tick()
      failed = true
      throw new Error('502')
    })
    const queued = run(async () => made.push('queued'))
    await expect(first).rejects.toThrow('502')
    await expect(queued).rejects.toBeInstanceOf(Abandoned)
    expect(made).toEqual(['first'])
  })
})
