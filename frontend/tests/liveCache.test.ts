import { describe, expect, it } from 'vitest'
import { keepPreviousData, QueryClient, QueryObserver } from '@tanstack/react-query'

// The live-window queries rely on this (state/data.ts): with gcTime 0 the
// dead key of the previous rebuild leaves the cache at once, while the
// observer keeps showing its data as a placeholder until the next build lands.
describe('live view cache', () => {
  it('drops old rebuild keys but keeps the previous view during a rebuild', async () => {
    const qc = new QueryClient()
    let release: (v: string) => void = () => {}
    const opts = (rev: number, fn: () => Promise<string>) => ({
      queryKey: ['snapshot', `#${rev}`], queryFn: fn, gcTime: 0, placeholderData: keepPreviousData,
    })
    const obs = new QueryObserver<string>(qc, opts(1, async () => 'view 1'))
    const seen: { data?: string; placeholder: boolean }[] = []
    const unsub = obs.subscribe((r) => seen.push({ data: r.data, placeholder: r.isPlaceholderData }))
    await expect.poll(() => obs.getCurrentResult().data).toBe('view 1')

    obs.setOptions(opts(2, () => new Promise<string>((r) => (release = r))))
    await new Promise((r) => setTimeout(r, 10)) // let gc run
    expect(obs.getCurrentResult()).toMatchObject({ data: 'view 1', isPlaceholderData: true })
    expect(qc.getQueryCache().find({ queryKey: ['snapshot', '#1'] })).toBeUndefined()

    release('view 2')
    await expect.poll(() => obs.getCurrentResult().data).toBe('view 2')
    const after = seen.slice(seen.findIndex((s) => s.data === 'view 1'))
    expect(after.every((s) => s.data !== undefined)).toBe(true) // never blank in between
    expect(after.some((s) => s.placeholder)).toBe(true)
    unsub()
  })
})
