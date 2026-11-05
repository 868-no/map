// The server's clock as last seen (retention's `now`, live heartbeats). A
// window may end at most a few seconds past the server's now (the backend's
// window.ClockSkew is 5 s; later ends are answered 400), so window ends
// follow the server's clock, not a local one that may run fast or slow.

let offsetMs = 0 // server time minus local time

/** Records the server's time `serverIso`, as received at local time `at`. */
export function noteServerTime(serverIso: string, at = Date.now()) {
  const t = Date.parse(serverIso)
  if (!Number.isNaN(t)) offsetMs = t - at
}

/** Now by the server's clock (the local clock until the server was heard from). */
export function serverNow(local = Date.now()): number {
  return local + offsetMs
}
