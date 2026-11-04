// Telling a backend that is down from one that is only busy (D-156).

/** A proxy's answer while the backend is down or restarting: no answer from it. */
const GATEWAY_DOWN = new Set([502, 503, 504])

/**
 * Whether a response came from the backend itself (huma's problem+json), not
 * from a proxy standing in for it or the service worker's offline stand-in.
 * The backend's own 503 ("server busy, retry shortly") means it is up but
 * loaded: retry, never switch to the saved copy.
 */
export function fromBackend(res: { headers: Headers }): boolean {
  return (res.headers.get('content-type') ?? '').includes('application/problem+json') && res.headers.get('x-meshmap-offline') !== '1'
}

/** A 502/503/504 that is no answer from the backend (it is down or restarting). */
export function gatewayDown(res: { status: number; headers: Headers }): boolean {
  return GATEWAY_DOWN.has(res.status) && !fromBackend(res)
}

/** The backend answered but is too loaded right now: worth another try shortly. */
export function backendBusy(res: { status: number; headers: Headers }): boolean {
  return res.status === 429 || (res.status === 503 && fromBackend(res))
}

/** Milliseconds to wait before retry `attempt` (0-based) of a busy answer. */
export function retryDelay(res: { headers: Headers }, attempt: number): number {
  const after = Number(res.headers.get('Retry-After'))
  return Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt, 10_000)
}
