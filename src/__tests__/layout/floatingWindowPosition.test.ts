import { describe, expect, it } from 'bun:test'
import { clampFloatingPanelPosition } from '@admin/shared/FloatingWindow'

describe('floating window viewport clamp', () => {
  it('keeps a reachable header strip after a far-left drag', () => {
    expect(clampFloatingPanelPosition(
      { x: -5_000, y: 80 },
      { viewportWidth: 1_000, viewportHeight: 700, panelWidth: 820 },
    )).toEqual({ x: -770, y: 80 })
  })

  it('reclamps a stored wide-window position against a narrower reopened panel', () => {
    expect(clampFloatingPanelPosition(
      { x: -770, y: 900 },
      { viewportWidth: 600, viewportHeight: 500, panelWidth: 520 },
    )).toEqual({ x: -470, y: 450 })
  })
})
