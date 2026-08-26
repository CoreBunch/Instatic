/**
 * Focus area → `object-position`.
 *
 * The published bytes are the cropped frame while the focus is stored against
 * the original upload, so every case here is a space conversion that would
 * otherwise fail silently — the image still renders, just framed on the wrong
 * part of the subject.
 */
import { describe, expect, it } from 'bun:test'
import { focusObjectPosition } from '@modules/base/image/focusPosition'

/**
 * A focus area centred on `x`/`y`. The extent is deliberately arbitrary: these
 * tests are about the centre, which is the only part `object-position` can
 * express.
 */
function at(x: number, y: number, width = 0.4, height = 0.4) {
  return { x, y, width, height }
}

describe('focusObjectPosition', () => {
  it('returns null without a focus area', () => {
    expect(focusObjectPosition(null, null)).toBeNull()
    expect(focusObjectPosition(undefined, { x: 0, y: 0, width: 1, height: 1 })).toBeNull()
  })

  it('omits the default centre so no needless style is emitted', () => {
    expect(focusObjectPosition(at(0.5, 0.5), null)).toBeNull()
  })

  it('maps a focus centre into an uncropped frame directly', () => {
    expect(focusObjectPosition(at(0.25, 0.8), null)).toBe('25% 80%')
  })

  it('re-bases the centre onto the cropped frame', () => {
    // Crop takes the right half; a point at 0.75 of the original is dead
    // centre of that half.
    const crop = { x: 0.5, y: 0, width: 0.5, height: 1 }
    expect(focusObjectPosition(at(0.75, 0.2), crop)).toBe('50% 20%')
  })

  it('clamps a focus centre that the crop cut away', () => {
    // Focus on the left edge, crop keeps the right half: the closest
    // surviving pixel is the crop's left edge, not a negative percentage.
    const crop = { x: 0.5, y: 0, width: 0.5, height: 1 }
    expect(focusObjectPosition(at(0.1, 0.9), crop)).toBe('0% 90%')
  })

  it('survives a degenerate crop without dividing by zero', () => {
    const crop = { x: 0, y: 0, width: 0, height: 0 }
    expect(focusObjectPosition(at(0.3, 0.3), crop)).toBe('30% 30%')
  })

  // Pins the deliberate limit of the current design: `object-position` names a
  // point, so the recorded extent cannot change the published value. If a
  // future art-directed variant ladder makes the extent bite, this is the test
  // that should fail and be rewritten — not one to quietly delete.
  it('ignores the extent — only the centre reaches the published style', () => {
    const small = focusObjectPosition(at(0.25, 0.8, 0.05, 0.05), null)
    const large = focusObjectPosition(at(0.25, 0.8, 0.9, 0.9), null)
    expect(small).toBe('25% 80%')
    expect(large).toBe(small)
  })
})
