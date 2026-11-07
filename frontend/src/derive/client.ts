// Page side of the derivation worker: every view is built there, in the
// WebAssembly engine (D-031, D-040).
import type { Capabilities, ObsRow } from '../api/types'
import type { Request, Response, TerrainLinkClass, Transmission, ViewRequest } from './protocol'
import { ViewError } from './views'

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, { resolve: (r: { body: unknown; offline: boolean }) => void; reject: (e: Error) => void }>()
let onChanged: (() => void) | undefined
let onPings: ((t: Transmission[]) => void) | undefined
const decoder = new TextDecoder()

let caps: Capabilities | undefined // re-sent to a restarted worker
let terrain: TerrainLinkClass[] = [] // likewise
let generation: string | null = null // likewise
let maxNodes: number | null = null // likewise
let restarts: number[] = [] // recent restart times
let broken: string | null = null // gave up restarting: views fail with this
let stopped = false // stopDerive: no worker is started again in this page

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
  if (caps) initDerive(caps) // with the terrain classes and node limit
  if (generation && usable()) get().postMessage({ type: 'generation', generation } satisfies Request)
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

/** Whether a message may start (or reach) a worker. */
const usable = () => !broken && !stopped

/**
 * Stops the worker (and so its database connection) for good: no streamed
 * row, setting or view starts another one, so none opens the database again
 * while it is being deleted. Views fail until the page reloads.
 */
export function stopDerive(): void {
  stopped = true
  worker?.terminate()
  worker = null
  for (const w of waiting.values()) w.reject(new ViewError('unavailable', 'stopped'))
  waiting.clear()
}

/**
 * Called (batched) when streamed rows changed what the views would show.
 * One listener, as for onTransmissions; returns its removal.
 */
export function onDerivedChange(fn: () => void): () => void {
  onChanged = fn
  return () => {
    if (onChanged === fn) onChanged = undefined
  }
}

/**
 * Called with the transmissions of live rows sent with sendLiveRows(…, ping).
 * One listener (the live stream's): a later one replaces it. Returns its
 * removal.
 */
export function onTransmissions(fn: (t: Transmission[]) => void): () => void {
  onPings = fn
  return () => {
    if (onPings === fn) onPings = undefined
  }
}

/** Hand rows from the live stream to the worker; ping lists the indexes to animate. */
export function sendLiveRows(rows: ObsRow[], ping: number[]): void {
  if (rows.length && usable()) get().postMessage({ type: 'rows', rows, ping } satisfies Request)
}

export function initDerive(c: Capabilities): void {
  caps = c
  if (!usable()) return
  const msg: Request = { type: 'init', geo: c.geolocation, liveQuantumMs: c.live_quantum_seconds * 1000, maxNodes: maxNodes ?? undefined, terrain }
  get().postMessage(msg)
}

/** The server's generation from a live (not offline) /retention answer (D-170). */
export function hintGeneration(g: string): void {
  generation = g
  if (usable()) get().postMessage({ type: 'generation', generation: g } satisfies Request)
}

/**
 * The snapshot's node limit (D-182); views are rebuilt with it. Before
 * init it only rides along with init, so the first build already uses it.
 */
export function setMaxNodes(n: number): void {
  if (n === maxNodes) return
  maxNodes = n
  if (caps && usable()) get().postMessage({ type: 'options', maxNodes: n } satisfies Request)
}

/** Line-of-sight classes of router links (D-143); views are rebuilt with them. */
export function sendTerrain(links: TerrainLinkClass[]): void {
  terrain = links
  if (caps && usable()) get().postMessage({ type: 'terrain', links } satisfies Request)
}

/** Ask the worker for a view; resolves with the view body (with meta). An abort stops waiting, and the build if it has not begun. */
export function deriveView(req: Omit<ViewRequest, 'type' | 'id'>, signal?: AbortSignal): Promise<{ body: unknown; offline: boolean }> {
  const id = nextId++
  if (stopped) return Promise.reject(new ViewError('unavailable', 'stopped: reload the page'))
  if (broken) return Promise.reject(new ViewError('internal', `the derivation engine cannot run in this browser (${broken}); reload to try again`))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (!waiting.delete(id)) return
      reject(new DOMException('aborted', 'AbortError'))
      // A view still waiting on a sync is not built for nobody.
      worker?.postMessage({ type: 'cancel', id } satisfies Request)
    }
    // The listener goes when the view settles: a long-lived signal would otherwise keep every request's.
    const settled = <T,>(f: (v: T) => void) => (v: T) => {
      signal?.removeEventListener('abort', onAbort)
      f(v)
    }
    waiting.set(id, { resolve: settled(resolve), reject: settled(reject) })
    signal?.addEventListener('abort', onAbort, { once: true })
    get().postMessage({ ...req, type: 'view', id } satisfies Request)
  })
}
