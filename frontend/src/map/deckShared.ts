// Shared deck.gl settings for the mesh overlay.
import { PathStyleExtension } from '@deck.gl/extensions'
import { LABELS_BEFORE } from './style'

// Interleaved overlay prop (typed by @deck.gl/mapbox as LayerOverlayProps but
// not merged into layer props): insert mesh layers beneath the label layers.
export const UNDER_LABELS: { beforeId?: string } = { beforeId: LABELS_BEFORE }

export const dashExt = new PathStyleExtension({ dash: true })
/** Dashes, and paths drawn beside their centre line (the two legs of a traceroute). */
export const dashOffsetExt = new PathStyleExtension({ dash: true, offset: true })

export type RGBA = [number, number, number, number]
