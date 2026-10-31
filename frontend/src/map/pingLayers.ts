// Per-frame layers for the radar-ping animation (state lives in pings.ts).
import { ScatterplotLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { activePings, RING_BANDS, type Blip, type Flash, type Ring } from './pings'
import { UNDER_LABELS, type RGBA } from './deckShared'

// Ping colours: first broadcast by the originator, rebroadcast by a relay.
export const PING_ORIGIN: [number, number, number] = [125, 224, 255]
export const PING_RELAY: [number, number, number] = [255, 196, 110]
const rgb = (r: { rebroadcast: boolean }) => (r.rebroadcast ? PING_RELAY : PING_ORIGIN)

export function buildPingLayers(now: number, zoom: number): Layer[] {
  const { rings, blips, flashes } = activePings(now, zoom)
  return [
    // Radial fill: concentric bands whose opacity follows the signal
    // measured at each receiver, fading to transparent at the edge.
    new ScatterplotLayer<{ r: Ring; i: number }>({
      id: 'ping-fill', ...UNDER_LABELS, data: rings.flatMap((r) => r.profile.map((_, i) => ({ r, i }))),
      getPosition: (b) => b.r.center, getRadius: (b) => ((b.i + 0.5) / RING_BANDS) * b.r.radiusPx, radiusUnits: 'pixels',
      filled: false, stroked: true, lineWidthUnits: 'pixels', getLineWidth: (b) => b.r.radiusPx / RING_BANDS,
      getLineColor: (b) => [...rgb(b.r), Math.round(b.r.alpha * 0.3 * b.r.profile[b.i])] as RGBA,
      updateTriggers: { getRadius: now, getLineWidth: now, getLineColor: now },
    }),
    // Expanding ring around the transmitter, out to its farthest direct receiver.
    new ScatterplotLayer<Ring>({
      id: 'ping-rings', ...UNDER_LABELS, data: rings, getPosition: (r) => r.center, getRadius: (r) => r.radiusPx, radiusUnits: 'pixels',
      filled: false, stroked: true, lineWidthUnits: 'pixels', getLineWidth: 2,
      getLineColor: (r) => [...rgb(r), r.alpha] as RGBA,
      updateTriggers: { getRadius: now, getLineColor: now },
    }),
    // No placeable direct receiver: a brief soft glow, deliberately unlike a ring.
    new ScatterplotLayer<Blip>({
      id: 'ping-blips', ...UNDER_LABELS, data: blips, getPosition: (r) => r.center, getRadius: (r) => 5 + 9 * r.scale, radiusUnits: 'pixels',
      filled: true, stroked: false, getFillColor: (r) => [...rgb(r), Math.round(r.alpha * 0.45)] as RGBA,
      updateTriggers: { getRadius: now, getFillColor: now },
    }),
    // A receiver lights up as the wavefront reaches it.
    new ScatterplotLayer<Flash>({
      id: 'ping-hits', ...UNDER_LABELS, data: flashes, getPosition: (f) => f.pos, getRadius: (f) => 7 + 7 * f.scale, radiusUnits: 'pixels',
      filled: false, stroked: true, lineWidthUnits: 'pixels', getLineWidth: 2.5,
      getLineColor: (f) => [...rgb(f), f.alpha] as RGBA,
      updateTriggers: { getRadius: now, getLineColor: now },
    }),
  ]
}
