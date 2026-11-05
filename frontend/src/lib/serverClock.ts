// The server's clock as last seen (retention's `now`, live heartbeats). A
// window may end at most a few seconds past the server's now (the backend's
// window.ClockSkew is 5 s; later ends are answered 400), so window ends
// follow the server's clock, not a local one that may run fast or slow.
//
// A reading arrives late, never early, so it can only make the server look
// behind: a frozen background tab handles a backlog of heartbeats all at once
// when it thaws, each minutes old. Taken at face value they would put the
// server's now back at the backlog's time, and the backlog's rows would look
// fresh (an explosion of pings on return, D-176). So the highest reading
// wins at once; lower readings take over only when they persist across
// SETTLE_MS of local time (the local clock was stepped forward), which a
// backlog handled in one go never does.

const SETTLE_MS = 20_000

let offsetMs = 0 // server time minus local time
let known = false
// Readings below the estimate: the highest of them, since a local time.
let lower: { offset: number; since: number } | undefined

/** Records the server's time `serverIso`, as received at local time `at`. */
export function noteServerTime(serverIso: string, at = Date.now()) {
  const t = Date.parse(serverIso)
  if (Number.isNaN(t)) return
  const o = t - at
  if (!known || o >= offsetMs) {
    offsetMs = o
    known = true
    lower = undefined
    return
  }
  if (!lower || at < lower.since) lower = { offset: o, since: at }
  else lower.offset = Math.max(lower.offset, o)
  if (at - lower.since >= SETTLE_MS) {
    offsetMs = lower.offset
    lower = undefined
  }
}

/** Now by the server's clock (the local clock until the server was heard from). */
export function serverNow(local = Date.now()): number {
  return local + offsetMs
}

/** Forget what was heard (tests). */
export function resetServerClock() {
  offsetMs = 0
  known = false
  lower = undefined
}
