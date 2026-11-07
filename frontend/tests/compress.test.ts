// @vitest-environment node
// (jsdom's Blob has no stream(); the cache runs in a worker, where it does.)
import { describe, expect, it } from 'vitest'
import { gunzip, gzip } from '../src/derive/compress'

describe('compression of cached texts', () => {
  it('gives back the text it was given, smaller in between', async () => {
    const text = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i, t: i * 1000, y: 'text', n: 'Ålesund ✓' })) })
    const blob = await gzip(text)
    expect(blob.size).toBeLessThan(text.length / 4)
    expect(await gunzip(blob)).toBe(text)
  })
})
