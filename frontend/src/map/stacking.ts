// Stacking levels for node markers and their MQTT glyphs (D-072).
//
// Markers are one layer and glyphs another, so drawing all glyphs after all
// markers put a node's glyph above markers drawn later that overlap it. A
// node's level is the highest level among earlier nodes it overlaps, one
// higher when that earlier node has a glyph; each level's glyphs are drawn
// after its markers, and markers of higher levels are drawn again on top. A
// glyph then shows above exactly the markers it belongs above.

export interface Disc {
  x: number // screen pixels
  y: number
  r: number // radius including the outline
  glyph: boolean
}

/** Levels per disc, in draw order (0 for most). Grid-bucketed: linear in practice. */
export function stackLevels(discs: Disc[]): number[] {
  const levels = new Array<number>(discs.length).fill(0)
  if (discs.length === 0) return levels
  // A loop, not a spread: one argument per disc overflows engines' limits at tens of thousands.
  let cell = 0
  for (const d of discs) cell = Math.max(cell, d.r * 2)
  cell ||= 1
  const grid = new Map<string, number[]>()
  const key = (cx: number, cy: number) => `${cx},${cy}`
  discs.forEach((d, j) => {
    const cx = Math.floor(d.x / cell), cy = Math.floor(d.y / cell)
    let level = 0
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const k of grid.get(key(cx + dx, cy + dy)) ?? []) {
          const e = discs[k]
          if (Math.hypot(e.x - d.x, e.y - d.y) < e.r + d.r) level = Math.max(level, levels[k] + (e.glyph ? 1 : 0))
        }
    levels[j] = level
    const g = grid.get(key(cx, cy))
    if (g) g.push(j)
    else grid.set(key(cx, cy), [j])
  })
  return levels
}
