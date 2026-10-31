// Page side of the derivation worker. Views are built in the browser by
// default; ?derive=server (remembered) switches back to the server's views
// for comparison, and ?derive=client returns to the default.
import type { Capabilities, ObsRow } from '../api/types'
import { ApiError } from '../api/client'
import type { Request, Response, ViewRequest } from './protocol'

export type DeriveMode = 'client' | 'server'
const KEY = 'meshmap:derive'

export function deriveMode(): DeriveMode {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return 'server'
  try {
    const q = new URLSearchParams(window.location.search).get('derive')
    if (q === 'client' || q === 'server') window.localStorage.setItem(KEY, q)
    return window.localStorage.getItem(KEY) === 'server' ? 'server' : 'client'
  } catch {
    return 'client'
  }
}

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { resolve: (r: { body: unknown; offline: boolean }) => void; reject: (e: Error) => void }>()

function get(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<Response>) => {
    const r = e.data
    if ('type' in r) {
      onChanged?.()
      return
    }
    const w = waiting.get(r.id)
    if (!w) return
    waiting.delete(r.id)
    if (r.ok) w.resolve({ body: r.body, offline: r.offline })
    else w.reject(new ApiError(r.status, r.message))
  }
  return worker
}

let onChanged: (() => void) | undefined

/** Called (batched) when streamed rows changed what the views would show. */
export function onDerivedChange(fn: () => void): void {
  onChanged = fn
}

/** Hand rows from the live stream to the worker. */
export function sendLiveRows(rows: ObsRow[]): void {
  if (rows.length) get().postMessage({ type: 'rows', rows } satisfies Request)
}

export function initDerive(caps: Capabilities): void {
  const msg: Request = { type: 'init', geo: caps.geolocation, liveQuantumMs: caps.live_quantum_seconds * 1000 }
  get().postMessage(msg)
}

/** Ask the worker for a view; resolves with the API-shaped body. Aborts only stop waiting. */
export function deriveView(req: Omit<ViewRequest, 'type' | 'id'>, signal?: AbortSignal): Promise<{ body: unknown; offline: boolean }> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    signal?.addEventListener('abort', () => {
      if (waiting.delete(id)) reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
    get().postMessage({ ...req, type: 'view', id } satisfies Request)
  })
}
