// Draw order by depth (D-187): node markers and their glyphs are two layers,
// yet each glyph must show above its own disc and below the discs of nodes
// drawn after it. Each instance is moved towards the camera by its place in
// the draw order (a disc at 2k, its glyphs at 2k + 1), so the depth test
// sorts them across both layers. The map is never pitched (maxPitch 0): every
// point on it is at one depth, and the shift moves nothing on screen.
import { LayerExtension, type Accessor, type DefaultProps, type Layer } from '@deck.gl/core'

export type DrawOrderProps<D> = {
  /** Place in the draw order: higher is drawn above. Whole numbers up to a few tens of thousands. */
  getDrawOrder?: Accessor<D, number>
}

/**
 * The depth step per place, in clip space. A 24-bit depth buffer resolves
 * about 1.2e-7 of it; 1e-6 keeps every step distinct, and 10 000 places
 * (5 000 nodes) span 0.01 of the depth range.
 */
const STEP = '1.0e-6'

const defaultProps: DefaultProps<DrawOrderProps<unknown>> = {
  getDrawOrder: { type: 'accessor', value: 0 },
}

class DrawOrderExtension extends LayerExtension {
  static extensionName = 'DrawOrderExtension'
  static defaultProps = defaultProps

  getShaders() {
    return {
      inject: {
        'vs:#decl': 'in float instanceDrawOrder;',
        'vs:DECKGL_FILTER_GL_POSITION': `position.z -= instanceDrawOrder * ${STEP} * position.w;`,
        // Nothing drawn, no depth written: the clear inside of a hollow
        // (estimated) marker must not hide the glyphs beneath it.
        'fs:DECKGL_FILTER_COLOR': 'if (color.a == 0.0) discard;',
      },
    }
  }

  initializeState(this: Layer<DrawOrderProps<unknown>>) {
    this.getAttributeManager()?.addInstanced({
      instanceDrawOrder: { size: 1, accessor: 'getDrawOrder' },
    })
  }
}

export const drawOrder = new DrawOrderExtension()

/** For layers drawn after the markers: on top of them, whatever their depth. */
export const OVER_MARKERS = { parameters: { depthCompare: 'always' as const } }
