// Overlay colours per theme. The route and opt-out colours read on both
// basemaps; the node age ramp has a deeper light-theme variant; everything drawn in the basemap's
// own tones (text, outlines, selection, links, pings) changes with it.
import type { Theme } from '../theme'
import type { RegionId } from './regionData'
import { AGE_STOPS } from './model'

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
  linkMqtt: RGB // hops that went over MQTT, not radio
  precision: RGB // reported position's precision cell
  estimate: RGB // estimate uncertainty circle
  pingOrigin: RGB // first broadcast by the originator
  pingRelay: RGB // rebroadcast by a relay
  pingCore: (c: RGB) => RGB // the travelling link's bright core
  regions: Record<RegionId, RGB> // landsdel tints (outline and name)
  ageStops: [number, number, number][] // node colour by last heard (model.ts)
  zeroCost: RGB // chevrons on 0-cost links (D-068)
  trail: RGB // trails behind moving nodes, and the airplane badge (D-073)
  reach: RGB[] // reach paths by hop limit needed, 0..7 (D-069)
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
    linkMqtt: [120, 230, 140],
    precision: [230, 237, 243],
    estimate: [176, 156, 255],
    pingOrigin: [125, 224, 255],
    pingRelay: [255, 196, 110],
    pingCore: (c) => toward(c, 255, 0.45),
    regions: { nord: [129, 161, 255], trondelag: [255, 170, 120], vest: [110, 210, 190], ost: [230, 140, 200], sor: [235, 215, 110] },
    ageStops: AGE_STOPS,
    zeroCost: [255, 214, 90],
    trail: [225, 232, 240],
    reach: [[95, 225, 140], [205, 232, 85], [255, 196, 70], [255, 135, 65], [240, 85, 95], [215, 90, 205], [150, 115, 255], [110, 170, 255]],
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
    linkMqtt: [20, 140, 60],
    precision: [40, 46, 54],
    estimate: [98, 70, 196],
    pingOrigin: [0, 150, 210],
    pingRelay: [222, 128, 0],
    pingCore: (c) => toward(c, 0, 0.25),
    regions: { nord: [60, 90, 200], trondelag: [196, 98, 36], vest: [16, 132, 112], ost: [168, 58, 138], sor: [150, 120, 10] },
    ageStops: AGE_STOPS,
    zeroCost: [176, 118, 0],
    trail: [40, 46, 56],
    reach: [[20, 150, 70], [125, 150, 0], [205, 135, 0], [220, 85, 20], [200, 35, 55], [170, 40, 160], [100, 60, 210], [30, 110, 210]],
  },
}
