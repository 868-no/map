import { describe, expect, it } from 'vitest'
import { stackLevels } from '../src/map/stacking'

describe('marker and glyph stacking (D-072)', () => {
  it('lifts a marker above an earlier overlapping glyph, and only then', () => {
    // a (glyph) under b (no glyph) overlapping; c far away.
    expect(stackLevels([{ x: 0, y: 0, r: 6, glyph: true }, { x: 5, y: 0, r: 6, glyph: false }, { x: 100, y: 0, r: 6, glyph: true }])).toEqual([0, 1, 0])
    // Nothing to cover: everything stays in the base layer.
    expect(stackLevels([{ x: 0, y: 0, r: 6, glyph: false }, { x: 5, y: 0, r: 6, glyph: true }])).toEqual([0, 0])
  })
  it('keeps later nodes above earlier ones they overlap, through chains', () => {
    // a(glyph) < b(glyph) < c: each sits above the one before it.
    expect(stackLevels([{ x: 0, y: 0, r: 6, glyph: true }, { x: 6, y: 0, r: 6, glyph: true }, { x: 12, y: 0, r: 6, glyph: false }])).toEqual([0, 1, 2])
    // d overlaps only b, which was lifted without a glyph: d stays level with it.
    expect(stackLevels([{ x: 0, y: 0, r: 6, glyph: true }, { x: 8, y: 0, r: 6, glyph: false }, { x: 18, y: 0, r: 6, glyph: false }])).toEqual([0, 1, 1])
  })
})
