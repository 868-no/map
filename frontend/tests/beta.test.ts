import { describe, expect, it } from 'vitest'
import { KONAMI, konamiStep } from '../src/state/beta'

const run = (keys: string[]) => keys.reduce(konamiStep, 0)

describe('Konami code (D-215)', () => {
  it('completes on the whole code, in any letter case', () => {
    expect(run([...KONAMI])).toBe(KONAMI.length)
    expect(run(['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'B', 'A'])).toBe(KONAMI.length)
  })
  it('restarts on a wrong key, and survives an extra up at the start', () => {
    expect(run(['arrowup', 'arrowup', 'arrowdown', 'x'])).toBe(0)
    expect(run(['arrowup', 'arrowup', 'arrowup', ...KONAMI.slice(2)])).toBe(KONAMI.length)
    expect(run(['arrowdown', 'arrowup'])).toBe(1)
  })
})
