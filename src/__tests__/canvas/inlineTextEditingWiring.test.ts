/**
 * Inline text editing — canvas wiring gates.
 *
 * Source-assertion tests (canvasNotch.test.ts convention) for the pieces
 * that only manifest inside live iframes and the full canvas mount:
 * double-click → startInlineEdit, the per-frame hidden-text attribute, and
 * the canvas-chrome CSS rule that must NOT use `color: transparent`
 * (the overlay mirrors computed color for the field's own text).
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'

const CANVAS_ROOT = new URL('../../admin/pages/site/canvas/CanvasRoot.tsx', import.meta.url)
const NODE_RENDERER = new URL('../../admin/pages/site/canvas/NodeRenderer.tsx', import.meta.url)
const IFRAME_BODY_RESET = new URL('../../admin/pages/site/canvas/iframeBodyReset.ts', import.meta.url)
const BREAKPOINT_FRAME = new URL('../../admin/pages/site/canvas/BreakpointFrame.tsx', import.meta.url)
const CONTEXTS = new URL('../../admin/pages/site/canvas/CanvasContexts.ts', import.meta.url)

describe('inline text editing wiring', () => {
  it('CanvasRoot starts a session on node double-click, gated to design mode', () => {
    const src = readFileSync(CANVAS_ROOT, 'utf-8')
    expect(src).toContain('startInlineEdit')
    expect(src).toContain('permissions.canEditContent')
  })

  it('the double-click context channel carries the originating breakpoint', () => {
    const src = readFileSync(CONTEXTS, 'utf-8')
    expect(src).toContain('onNodeDoubleClick: (nodeId: string, e: MouseEvent, breakpointId?: string) => void')
  })

  it('NodeRenderer flags the edited node in the session frame only', () => {
    const src = readFileSync(NODE_RENDERER, 'utf-8')
    expect(src).toContain("'data-instatic-inline-editing'")
    expect(src).toContain('s.activeInlineEdit.breakpointId === breakpointId')
  })

  it('the canvas chrome hides doubled text via text-fill-color, never color', () => {
    const src = readFileSync(IFRAME_BODY_RESET, 'utf-8')
    expect(src).toContain('[data-instatic-inline-editing="true"]')
    expect(src).toContain('-webkit-text-fill-color: transparent !important')
    // The overlay mirrors getComputedStyle(el).color — color:transparent
    // would feed transparent back into the field's own text. The [^-]
    // guard skips -webkit-*-color longhands, which are fine.
    expect(src).not.toMatch(/[^-]color: transparent !important/)
  })

  it('BreakpointFrame mounts the overlay next to the selection overlay', () => {
    const src = readFileSync(BREAKPOINT_FRAME, 'utf-8')
    expect(src).toContain('<InlineTextEditOverlay')
  })
})
