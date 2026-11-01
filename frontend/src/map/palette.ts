// Overlay colours per theme. The node age ramp (model.ts) and the route and
// opt-out colours read on both basemaps; everything drawn in the basemap's
// own tones (text, outlines, selection, links, pings) changes with it.
import type { Theme } from '../theme'

type RGB = [number, number, number]
type RGBA = [number, number, number, number]

export interface MapPalette {
  selected: RGBA // selected node outline, link and name
  text: RGB // node names
  textEstimated: RGB // names of estimated nodes
  textOutline: RGBA
  leader: RGBA // lines from fanned-out names to their markers
  nodeOutline: RGBA // ordinary node outline
  gateway: RGB // gateway outline and marker highlight
  dimmed: RGBA // nodes not matching the search
  highlight: RGBA // hovered link
  linkInfra: RGB
  linkOther: RGB
  precision: RGB // reported position's precision cell
  estimate: RGB // estimate uncertainty circle
  pingOrigin: RGB // first broadcast by the originator
  pingRelay: RGB // rebroadcast by a relay
  pingCore: (c: RGB) => RGB // the travelling link's bright core
}

const toward = (c: RGB, target: number, f: number) => c.map((v) => Math.round(v + (target - v) * f)) as RGB

export const PALETTES: Record<Theme, MapPalette> = {
  dark: {
    selected: [255, 255, 255, 255],
    text: [230, 237, 243],
    textEstimated: [176, 156, 255],
    textOutline: [14, 17, 22, 255],
    leader: [230, 237, 243, 150],
    nodeOutline: [14, 17, 22, 255],
    gateway: [76, 201, 240],
    dimmed: [80, 85, 90, 120],
    highlight: [255, 255, 255, 80],
    linkInfra: [76, 201, 240],
    linkOther: [150, 163, 184],
    precision: [230, 237, 243],
    estimate: [176, 156, 255],
    pingOrigin: [125, 224, 255],
    pingRelay: [255, 196, 110],
    pingCore: (c) => toward(c, 255, 0.45),
  },
  light: {
    selected: [20, 24, 30, 255],
    text: [28, 32, 38],
    textEstimated: [98, 70, 196],
    textOutline: [250, 250, 248, 255],
    leader: [40, 46, 54, 150],
    nodeOutline: [40, 44, 50, 255],
    gateway: [8, 126, 164],
    dimmed: [150, 155, 160, 120],
    highlight: [0, 0, 0, 50],
    linkInfra: [8, 126, 164],
    linkOther: [98, 110, 128],
    precision: [40, 46, 54],
    estimate: [98, 70, 196],
    pingOrigin: [0, 150, 210],
    pingRelay: [222, 128, 0],
    pingCore: (c) => toward(c, 0, 0.25),
  },
}
