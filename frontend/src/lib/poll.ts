// Polling an answer the server is still completing (weather hours, terrain
// heights): soon at first, backing off to a minute, giving up after
// INCOMPLETE_POLLS answers (about 15 minutes), so an unreachable upstream
// never means polling for ever.

export const INCOMPLETE_POLLS = 25

export type IncompleteQuery = { state: { data?: { incomplete?: boolean }; dataUpdateCount: number } }

/** Whether polling has given up on an answer that is still incomplete. */
export const pollGaveUp = (q: IncompleteQuery) => !!q.state.data?.incomplete && q.state.dataUpdateCount > INCOMPLETE_POLLS

/** A refetchInterval: the next poll's delay while the answer is incomplete. */
export const pollIncomplete = (q: IncompleteQuery): number | false =>
  q.state.data?.incomplete && !pollGaveUp(q) ? Math.min(4000 * 1.3 ** q.state.dataUpdateCount, 60_000) : false
