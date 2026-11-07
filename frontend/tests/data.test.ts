import { describe, expect, it } from 'vitest'
import { retryView } from '../src/state/data'
import { ViewError } from '../src/derive/views'

describe('view retries', () => {
  it('asks once more after a failure that may pass', () => {
    for (const err of [new ViewError('unavailable', 'offline'), new ViewError('upstream', '500'), new ViewError('internal', 'restarting'), new Error('x')]) {
      expect(retryView(0, err)).toBe(true)
      expect(retryView(1, err)).toBe(false)
    }
  })

  it('never asks again for a node not in the window or a bad request', () => {
    expect(retryView(0, new ViewError('not_found', 'node not observed'))).toBe(false)
    expect(retryView(0, new ViewError('bad_request', 'bad filter'))).toBe(false)
  })
})
