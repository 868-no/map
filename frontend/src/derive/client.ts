// Page side of the derivation worker: every view is built there, in the
// WebAssembly engine (D-031, D-040).
import type { Capabilities, ObsRow } from '../api/types'
import type { Request, Response, Transmission, ViewRequest } from './protocol'
import { ViewError } from './views'

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { resolve: (r: { body: unknown; offline: boolean }) => void; reject: (e: Error) => void }>()
let onChanged: (() => void) | undefined
let onPings: ((t: Transmission[]) => void) | undefined
const decoder = new TextDecoder()

let caps: Capabilities | undefined // re-sent to a restarted worker
let restarts: number[] = [] // recent restart times
let broken: string | null = null // gave up restarting: views fail with this

/**
 * The worker died (a script error) or its engine trapped: fail what waits,
 * then start a fresh one, which syncs its rows again (from the browser's
 * database, then the server). Views are asked again through onChanged. More
 * than three restarts a minute means it cannot work here: views then fail
 * with the reason instead of retrying forever.
 */
function restart(why: string): void {
  console.error('derivation worker failed:', why)
  worker?.terminate()
  worker = null
  for (const w of waiting.values()) w.reject(new ViewError('internal', `the derivation engine failed (${why}); restarting`))
  waiting.clear()
  const now = Date.now()
  restarts = [...restarts.filter((t) => now - t < 60_000), now]
  if (restarts.length > 3) {
    broken = why
    return
  }
  if (caps) initDerive(caps)
  onChanged?.()
}

function get(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onerror = (e) => {
    e.preventDefault()
    restart(e.message || 'worker error')
  }
  worker.onmessage = (e: MessageEvent<Response>) => {
    const r = e.data
    if ('type' in r) {
      if (r.type === 'changed') onChanged?.()
      else if (r.type === 'fatal') restart(r.message)
      else onPings?.(r.transmissions)
      return
    }
    const w = waiting.get(r.id)
    if (!w) return
    waiting.delete(r.id)
    // Views arrive as transferred UTF-8 JSON: no structured clone of a large object graph.
    if (r.ok) w.resolve({ body: { ...(JSON.parse(decoder.decode(r.body)) as object), meta: r.meta }, offline: r.offline })
    else w.reject(new ViewError(r.kind, r.message))
  }
  return worker
}

/** Stops the worker (and so its database connection); views fail until reload. */
export function stopDerive(): void {
  worker?.terminate()
  worker = null
  for (const w of waiting.values()) w.reject(new ViewError('unavailable', 'stopped'))
  waiting.clear()
}

/** Called (batched) when streamed rows changed what the views would show. */
export function onDerivedChange(fn: () => void): void {
  onChanged = fn
}

/** Called with the transmissions of live rows sent with sendLiveRows(…, ping). */
export function onTransmissions(fn: (t: Transmission[]) => void): void {
  onPings = fn
}

/** Hand rows from the live stream to the worker; ping lists the indexes to animate. */
export function sendLiveRows(rows: ObsRow[], ping: number[]): void {
  if (rows.length && !broken) get().postMessage({ type: 'rows', rows, ping } satisfies Request)
}

export function initDerive(c: Capabilities): void {
  caps = c
  const msg: Request = { type: 'init', geo: c.geolocation, liveQuantumMs: c.live_quantum_seconds * 1000 }
  get().postMessage(msg)
}

/** Ask the worker for a view; resolves with the view body (with meta). Aborts only stop waiting. */
export function deriveView(req: Omit<ViewRequest, 'type' | 'id'>, signal?: AbortSignal): Promise<{ body: unknown; offline: boolean }> {
  const id = nextId++
  if (broken) return Promise.reject(new ViewError('internal', `the derivation engine cannot run in this browser (${broken}); reload to try again`))
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    signal?.addEventListener('abort', () => {
      if (waiting.delete(id)) reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
    get().postMessage({ ...req, type: 'view', id } satisfies Request)
  })
}
