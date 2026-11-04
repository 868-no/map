import { describe, expect, it } from 'vitest'
import { backendBusy, fromBackend, gatewayDown, retryDelay } from '../src/derive/httpStatus'

const res = (status: number, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers) })
const problem = { 'content-type': 'application/problem+json' }

describe('backend down or busy (D-156)', () => {
  it("takes a proxy's 502/503/504 for a backend that is down", () => {
    for (const s of [502, 503, 504]) {
      expect(gatewayDown(res(s, { 'content-type': 'text/html' }))).toBe(true)
      expect(gatewayDown(res(s))).toBe(true)
      expect(backendBusy(res(s, { 'content-type': 'text/html' }))).toBe(false)
    }
  })

  it("takes the backend's own problem+json 503 for busy, not down", () => {
    const busy = res(503, { 'content-type': 'application/problem+json; charset=utf-8' })
    expect(fromBackend(busy)).toBe(true)
    expect(gatewayDown(busy)).toBe(false)
    expect(backendBusy(busy)).toBe(true)
    expect(backendBusy(res(429))).toBe(true)
    expect(backendBusy(res(500, problem))).toBe(false)
  })

  it("takes the service worker's offline stand-in for down, though it is problem+json", () => {
    const sw = res(503, { ...problem, 'x-meshmap-offline': '1' })
    expect(gatewayDown(sw)).toBe(true)
    expect(backendBusy(sw)).toBe(false)
  })

  it('waits as told, else backs off, never past 10 s', () => {
    expect(retryDelay(res(429, { 'Retry-After': '3' }), 0)).toBe(3000)
    expect(retryDelay(res(429, { 'Retry-After': '60' }), 0)).toBe(10_000)
    expect([0, 1, 2, 5].map((a) => retryDelay(res(503, problem), a))).toEqual([1000, 2000, 4000, 10_000])
  })
})
