// Per-frame layers for the radar-ping animation (state lives in pings.ts).
import { LineLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import { activePings, RING_BANDS, type Blip, type DeliveryLine, type Flash, type Ring, type Trail } from './pings'
import type { RGBA } from './deckShared'
import type { MapPalette } from './palette'
// Rings have no outline: a soft fill whose opacity follows the signal at each
// receiver shows the reach, and the animated links' heads mark its edge.
const FILL_ALPHA = 0.18

export function buildPingLayers(now: number, zoom: number, palette: MapPalette): Layer[] {
  // Ping colours: first broadcast by the originator, rebroadcast by a relay;
  // the travelling link's core stands out from its glow.
  const rgb = (r: { rebroadcast: boolean }) => (r.rebroadcast ? palette.pingRelay : palette.pingOrigin)
  const bright = (r: { rebroadcast: boolean }) => palette.pingCore(rgb(r))
  const { rings, blips, flashes, trails, deliveries, arrivals } = activePings(now, zoom)
  const ok = palette.delivered
  const moving = trails.filter((t) => t.progress < 1)
  return [
    // The links the transmission travels: each grows from the transmitter
    // with the ring's edge, reaching its receiver as the ring does, then
    // settles (thinner, fainter) while the ring lingers and fades. Drawn as
    // a wide soft glow under a bright core so it reads over busy maps.
    new LineLayer<Trail>({
      id: 'ping-trail-glow', data: trails, getSourcePosition: (t) => t.from, getTargetPosition: (t) => t.tip,
      widthUnits: 'pixels', getWidth: (t) => (t.progress < 1 ? 10 : 5),
      getColor: (t) => [...rgb(t), Math.round(t.alpha * (t.progress < 1 ? 0.35 : 0.15))] as RGBA,
      updateTriggers: { getTargetPosition: now, getWidth: now, getColor: now },
    }),
    new LineLayer<Trail>({
      id: 'ping-trails', data: trails, getSourcePosition: (t) => t.from, getTargetPosition: (t) => t.tip,
      widthUnits: 'pixels', getWidth: (t) => (t.progress < 1 ? 3.5 : 2),
      getColor: (t) => [...bright(t), Math.round(t.alpha * (t.progress < 1 ? 1 : 0.6))] as RGBA,
      updateTriggers: { getTargetPosition: now, getWidth: now, getColor: now },
    }),
    // The travelling head, on the ring's edge: a halo and a bright point.
    new ScatterplotLayer<Trail>({
      id: 'ping-trail-halos', data: moving, getPosition: (t) => t.tip, getRadius: 11, radiusUnits: 'pixels',
      filled: true, stroked: false, getFillColor: (t) => [...rgb(t), Math.round(t.alpha * 0.35)] as RGBA,
      updateTriggers: { getPosition: now, getFillColor: now },
    }),
    new ScatterplotLayer<Trail>({
      id: 'ping-trail-heads', data: moving, getPosition: (t) => t.tip, getRadius: 5, radiusUnits: 'pixels',
      filled: true, stroked: false, getFillColor: (t) => [...bright(t), t.alpha] as RGBA,
      updateTriggers: { getPosition: now, getFillColor: now },
    }),
    // The ring itself: concentric bands whose opacity follows the signal
    // measured at each receiver, fading to transparent at the edge.
    new ScatterplotLayer<{ r: Ring; i: number }>({
      id: 'ping-fill', data: rings.flatMap((r) => r.profile.map((_, i) => ({ r, i }))),
      getPosition: (b) => b.r.center, getRadius: (b) => ((b.i + 0.5) / RING_BANDS) * b.r.radiusPx, radiusUnits: 'pixels',
      filled: false, stroked: true, lineWidthUnits: 'pixels', getLineWidth: (b) => b.r.radiusPx / RING_BANDS,
      getLineColor: (b) => [...rgb(b.r), Math.round(b.r.alpha * FILL_ALPHA * b.r.profile[b.i])] as RGBA,
      updateTriggers: { getRadius: now, getLineWidth: now, getLineColor: now },
    }),
    // No placeable direct receiver: a brief soft glow, deliberately unlike a ring.
    new ScatterplotLayer<Blip>({
      id: 'ping-blips', data: blips, getPosition: (r) => r.center, getRadius: (r) => 5 + 9 * r.scale, radiusUnits: 'pixels',
      filled: true, stroked: false, getFillColor: (r) => [...rgb(r), Math.round(r.alpha * 0.45)] as RGBA,
      updateTriggers: { getRadius: now, getFillColor: now },
    }),
    // A receiver lights up as the wavefront reaches it.
    new ScatterplotLayer<Flash>({
      id: 'ping-hits', data: flashes, getPosition: (f) => f.pos, getRadius: (f) => 7 + 7 * f.scale, radiusUnits: 'pixels',
      filled: false, stroked: true, lineWidthUnits: 'pixels', getLineWidth: 2.5,
      getLineColor: (f) => [...rgb(f), f.alpha] as RGBA,
      updateTriggers: { getRadius: now, getLineColor: now },
    }),
    // Deliveries (D-096): an ACK proved the packet reached this node, by a
    // path we may not know. A line travels from the sender, the receiver
    // gets a double flash on arrival.
    new LineLayer<DeliveryLine>({
      id: 'delivery-glow', data: deliveries, getSourcePosition: (d) => d.from, getTargetPosition: (d) => d.tip,
      widthUnits: 'pixels', getWidth: 9, getColor: (d) => [...ok, Math.round(d.alpha * 0.3)] as RGBA,
      updateTriggers: { getTargetPosition: now, getColor: now },
    }),
    new LineLayer<DeliveryLine>({
      id: 'delivery-lines', data: deliveries, getSourcePosition: (d) => d.from, getTargetPosition: (d) => d.tip,
      widthUnits: 'pixels', getWidth: 2.5, getColor: (d) => [...ok, d.alpha] as RGBA,
      updateTriggers: { getTargetPosition: now, getColor: now },
    }),
    new ScatterplotLayer<DeliveryLine>({
      id: 'delivery-heads', data: deliveries.filter((d) => d.progress < 1), getPosition: (d) => d.tip, getRadius: 5, radiusUnits: 'pixels',
      filled: true, stroked: false, getFillColor: (d) => [...ok, d.alpha] as RGBA,
      updateTriggers: { getPosition: now, getFillColor: now },
    }),
    new ScatterplotLayer<Flash>({
      id: 'delivery-arrivals', data: [...arrivals, ...arrivals.map((f) => ({ ...f, scale: f.scale * 2 }))],
      getPosition: (f) => f.pos, getRadius: (f) => 8 + 10 * f.scale, radiusUnits: 'pixels',
      filled: false, stroked: true, lineWidthUnits: 'pixels', getLineWidth: 3, getLineColor: (f) => [...ok, f.alpha] as RGBA,
      updateTriggers: { getRadius: now, getLineColor: now },
    }),
  ]
}
