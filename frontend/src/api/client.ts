import type { LiveEvent } from './types'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** GET a JSON endpoint; aborts propagate so superseded requests are cancelled. */
export async function getJSON<T>(path: string, params?: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const url = params && [...params.keys()].length ? `${path}?${params}` : path
  return readJSON<T>(await fetch(url, { signal, headers: { Accept: 'application/json' } }))
}

/** POST a JSON body to an endpoint that only reads (no state changes). */
export async function postJSON<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return readJSON<T>(await fetch(path, { method: 'POST', signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
}

async function readJSON<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.detail ?? body.title ?? detail
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

export interface Heartbeat {
  now: string
  window: { start: string; end: string; rolling: boolean }
}

export interface LiveHandlers {
  onDelta: (events: LiveEvent[]) => void
  onHeartbeat: (h: Heartbeat) => void
  onStatus: (live: boolean, reason?: string) => void
  onRetention: () => void
}

/**
 * Live SSE subscription with a heartbeat watchdog: if no heartbeat arrives
 * within 40 s the connection is recycled. EventSource reconnects on its own
 * for network errors.
 */
export function subscribeLive(params: URLSearchParams, h: LiveHandlers): () => void {
  let es: EventSource | null = null
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const arm = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      h.onStatus(false, 'heartbeat lost')
      open()
    }, 40_000)
  }
  const open = () => {
    es?.close()
    if (closed) return
    es = new EventSource(`/api/v1/stream?${params}`)
    es.addEventListener('delta', (e) => h.onDelta(JSON.parse((e as MessageEvent).data).events ?? []))
    es.addEventListener('heartbeat', (e) => {
      arm()
      h.onHeartbeat(JSON.parse((e as MessageEvent).data))
    })
    es.addEventListener('status', (e) => {
      const s = JSON.parse((e as MessageEvent).data)
      h.onStatus(!!s.live, s.reason)
    })
    es.addEventListener('retention', () => h.onRetention())
    es.onerror = () => h.onStatus(false, 'reconnecting')
    arm()
  }
  open()
  return () => {
    closed = true
    clearTimeout(watchdog)
    es?.close()
  }
}
