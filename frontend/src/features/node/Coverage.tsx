import type { NodeView } from '../../derive/views'
import { precisionErrorM } from '../../map/model'
import { nodeLink } from '../../state/store'
import { useBeta } from '../../state/beta'

/**
 * LinkSim's site-URL contract (D-214): docs/site-url.md in
 * github.com/wilhel1812/LinkSim. Staging until it reaches production.
 */
export const LINKSIM = 'https://staging.linksim.link/'

/**
 * Coarser positions put the simulated site too far from the node to be
 * useful: 15 bits, about 800 m in Norway, is what most nodes share.
 */
const MIN_BITS = 15

/**
 * A LinkSim coverage simulation from the node's place (D-214), or undefined
 * when there is none worth simulating: no current reported position (never an
 * estimate or a stale one), a position coarser than MIN_BITS, or a node
 * that did not allow MQTT (never handed to other services, §2.5).
 */
export function coverageLink(d: NodeView, origin = window.location.origin): string | undefined {
  const pos = d.position
  if (!pos || d.mqtt_opt_out) return undefined
  // A refined place narrows down jumping reports (D-077) but is never finer than the
  // node shares, so it must pass the same cutoff as the reported position.
  const at = d.refined ?? pos
  const ok = d.refined ? d.refined.radius_m <= precisionErrorM(MIN_BITS, at.lat) : pos.precision_known && pos.precision_bits >= MIN_BITS
  if (!ok) return undefined
  const q = new URLSearchParams({ site: '1', lat: at.lat.toFixed(5), lon: at.lon.toFixed(5) })
  const name = d.identity?.long_name
  if (name) q.set('name', name)
  // Ground elevation is left to LinkSim's terrain: the reported altitude is the radio's, not the ground's.
  q.set('source', new URL(origin).hostname)
  const self = nodeLink(d.id, origin)
  if (self.startsWith('https://')) q.set('sourceUrl', self) // LinkSim takes only HTTPS links
  return `${LINKSIM}?${q}`
}

/** Only in beta mode (D-215). */
export function CoverageLink({ d }: { d: NodeView }) {
  const beta = useBeta((s) => s.on)
  const href = beta ? coverageLink(d) : undefined
  if (!href) return null
  return (
    <a className="coverage-link" href={href} target="_blank" rel="noopener noreferrer"
      title="Simulate this node's radio coverage in LinkSim, an external service: opens it with the node's position and name">
      Coverage ↗
    </a>
  )
}
