// A node marker as the map draws it (D-186), for the legend: the disc in a
// last-heard colour, the role glyph, and a gateway's uplink badge.
import { glyphInk, MQTT_ARROW, type MqttFlow } from '../map/model'
import { GLYPH_STROKE, GLYPH_UNITS, ROLE_GLYPHS, UPLINK_BADGE, type RoleIcon } from '../map/roleIcons'
import type { MapPalette } from '../map/palette'

const rgb = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`

export function NodeIcon({ icon, palette, uplink, estimated, size = 20 }: { icon: RoleIcon; palette: MapPalette; uplink?: MqttFlow; estimated?: boolean; size?: number }) {
  const fill = palette.ageStops[0]
  const glyph = ROLE_GLYPHS[icon]
  const ink = estimated ? rgb(fill) : rgb(glyphInk(fill))
  const rim = uplink ? rgb(palette.gateway) : rgb(palette.nodeOutline)
  const half = GLYPH_UNITS / 2
  // Room for a badge on the rim, with or without one, so every icon in a list lines up.
  const pad = UPLINK_BADGE.r + UPLINK_BADGE.rim - (half - UPLINK_BADGE.x)
  const box = GLYPH_UNITS + pad * 2
  const id = `node-icon-cut-${icon}-${estimated ? 'e' : 'f'}`
  return (
    <svg className="node-icon" width={(size * box) / GLYPH_UNITS} height={(size * box) / GLYPH_UNITS} viewBox={`${-box / 2} ${-box / 2} ${box} ${box}`} aria-hidden>
      {glyph.cut && (
        <mask id={id}>
          <rect x={-half} y={-half} width={GLYPH_UNITS} height={GLYPH_UNITS} fill="#fff" />
          <path d={glyph.cut} fill="#000" />
        </mask>
      )}
      {estimated ? (
        <>
          <circle r={half - 0.6} fill="none" stroke={rgb(palette.nodeOutline)} strokeWidth={3} />
          <circle r={half - 0.6} fill="none" stroke={rgb(fill)} strokeWidth={1.6} />
        </>
      ) : (
        <circle r={half - (uplink ? 0.9 : 0.5)} fill={rgb(fill)} stroke={rim} strokeWidth={uplink ? 1.8 : 1} />
      )}
      <g mask={glyph.cut ? `url(#${id})` : undefined}>
        {glyph.stroke && <path d={glyph.stroke} fill="none" stroke={ink} strokeWidth={GLYPH_STROKE} strokeLinecap="round" />}
        {glyph.fill && <path d={glyph.fill} fill={ink} />}
      </g>
      {uplink && (
        <g transform={`translate(${UPLINK_BADGE.x} ${UPLINK_BADGE.y})`}>
          <circle r={UPLINK_BADGE.r} fill={rgb(palette.gateway)} stroke={rgb(palette.nodeOutline)} strokeWidth={UPLINK_BADGE.rim} />
          {/* The arrow icon (24 units) at the size the map draws it: 1.35 badge radii across. */}
          <path d={MQTT_ARROW[uplink]} fill={rgb(palette.nodeOutline)} transform={`scale(${(UPLINK_BADGE.r * 1.35) / 24}) translate(-12 -12)`} />
        </g>
      )}
    </svg>
  )
}
