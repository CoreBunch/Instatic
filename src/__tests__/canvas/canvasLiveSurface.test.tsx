/**
 * CanvasLiveSurface — loading state parity with the design canvas.
 *
 * While the page (or the site's breakpoints) are still hydrating, the live
 * surface must show the same shared `CanvasFrameSkeleton` the design canvas's
 * `CanvasTransformLayer` renders for a null page — not an empty state that
 * reads like "nothing to show".
 */

import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { CanvasLiveSurface } from '@site/canvas/CanvasLiveSurface'

afterEach(cleanup)

describe('CanvasLiveSurface — loading skeleton', () => {
  it('renders the shared frame skeleton while the page is hydrating', () => {
    const { container, getByTestId } = render(
      <CanvasLiveSurface page={null} activeBreakpoint={null} />,
    )

    expect(getByTestId('canvas-live-loading-frame')).toBeDefined()
    // The shared skeleton announces itself as a busy status region.
    expect(getByTestId('canvas-frame-skeleton-live').getAttribute('aria-busy')).toBe('true')
    expect(container.textContent).not.toContain('No page selected')
  })

  it('keys the skeleton to the active breakpoint when only the page is pending', () => {
    const { getByTestId } = render(
      <CanvasLiveSurface
        page={null}
        activeBreakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
      />,
    )

    expect(getByTestId('canvas-frame-skeleton-desktop')).toBeDefined()
  })
})
