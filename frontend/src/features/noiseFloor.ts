// Noise floors as chart lines (D-199): dashed, beside the readings they put
// in context, in the colour of the direction the measuring node receives.
import type { Series } from '../components/TimeChart'
import type { LinkHistory } from '../derive/views'

/** Lines for each end of a link that measures its noise floor; none for an end without local stats. */
export function linkFloorSeries(h: Pick<LinkHistory, 'floor_a' | 'floor_b'>, nameA: string, nameB: string): Series[] {
  const line = (name: string, color: string, pts: [number, number][] | undefined): Series[] =>
    pts?.length ? [{ label: `Noise floor at ${name}`, color, dashed: true, points: pts.map(([t, v]) => [t, v]) }] : []
  // b receives a → b (accent), a receives b → a (warn).
  return [...line(nameB, 'var(--accent)', h.floor_b), ...line(nameA, 'var(--warn)', h.floor_a)]
}
