import { describe, expect, it } from 'bun:test'
import {
  clampFloatingPanelPosition,
  clampFloatingPanelSize,
} from '@admin/shared/FloatingWindow'

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

describe('floating window size clamp', () => {
  it('respects minimum usable dimensions', () => {
    expect(clampFloatingPanelSize(
      { width: 80, height: 40 },
      {
        viewportWidth: 1_440,
        viewportHeight: 900,
        panelLeft: 400,
        panelTop: 160,
        minWidth: 280,
        minHeight: 240,
      },
    )).toEqual({ width: 280, height: 240 })
  })

  it('keeps a resized panel inside the available bottom-right viewport', () => {
    expect(clampFloatingPanelSize(
      { width: 2_000, height: 1_200 },
      {
        viewportWidth: 1_440,
        viewportHeight: 900,
        panelLeft: 400,
        panelTop: 160,
        minWidth: 280,
        minHeight: 240,
      },
    )).toEqual({ width: 1_024, height: 724 })
  })
})
