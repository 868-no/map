import type { Edge, Hearing } from '../../derive/views'

const CONF_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 }

/** A neighbour on the Links list: both directions of the link to it. */
export interface LinkNeighbour {
  peer: string
  mqtt: boolean
  out?: Edge // the neighbour heard this node
  in?: Edge // this node heard the neighbour
}

/**
 * The selected node's links grouped by neighbour (radio and internet links
 * apart), sorted by the better direction's confidence, then its median SNR
 * (strongest first), then name. Internet links follow the radio ones.
 */
export function linkNeighbours(edges: Edge[], id: string, names: Map<string, string>): LinkNeighbour[] {
  const groups = new Map<string, LinkNeighbour>()
  for (const e of edges) {
    if (e.src !== id && e.dst !== id) continue
    const peer = e.src === id ? e.dst : e.src
    const key = peer + (e.mqtt ? '|m' : '')
    const g = groups.get(key) ?? { peer, mqtt: !!e.mqtt }
    if (e.src === id) g.out = e
    else g.in = e
    groups.set(key, g)
  }
  const both = (g: LinkNeighbour) => [g.out, g.in].filter((e): e is Edge => !!e)
  const conf = (g: LinkNeighbour) => (g.mqtt ? 0 : Math.max(...both(g).map((e) => CONF_RANK[e.confidence] ?? 0)))
  const snr = (g: LinkNeighbour) => Math.max(...both(g).map((e) => e.snr.median ?? -999))
  return [...groups.values()].sort(
    (a, b) => conf(b) - conf(a) || snr(b) - snr(a) || (names.get(a.peer) ?? a.peer).localeCompare(names.get(b.peer) ?? b.peer),
  )
}

/**
 * Gateways that heard the node, sorted like the Links list: by the radio
 * link's confidence (none last: the gateway only got relayed copies), then
 * median SNR (strongest first), then name.
 */
export function sortHearings(heardBy: Hearing[], id: string, edges: Edge[], names: Map<string, string>): { h: Hearing; link?: Edge }[] {
  const links = new Map(edges.filter((e) => !e.mqtt && e.src === id).map((e) => [e.dst, e]))
  const rank = (x: { link?: Edge }) => (x.link ? CONF_RANK[x.link.confidence] ?? 0 : 0)
  const snr = (x: { h: Hearing }) => x.h.snr.median ?? -999
  const name = (x: { h: Hearing }) => names.get(x.h.node) ?? x.h.node
  return heardBy.map((h) => ({ h, link: links.get(h.node) })).sort((a, b) => rank(b) - rank(a) || snr(b) - snr(a) || name(a).localeCompare(name(b)))
}
