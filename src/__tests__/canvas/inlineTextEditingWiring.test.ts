/**
 * Inline text editing — canvas wiring gates.
 *
 * Source-assertion tests (canvasNotch.test.ts convention) for the pieces that
 * only manifest inside live iframes and the full canvas mount. The editor was
 * rewritten from a parent-document overlay to editing the REAL node element in
 * place via `contentEditable`, so these gates assert the in-place wiring:
 *
 *   - double-click → startInlineEdit, gated to design mode (CanvasRoot);
 *   - NodeRenderer builds an `InlineEditBinding`, passes `inlineEdit` to the
 *     component, and focuses the element via `useLayoutEffect`;
 *   - the canvas keyboard handler bails on `activeInlineEdit` so Delete/Cmd+D
 *     never fire mid-edit;
 *   - BreakpointFrame no longer mounts an inline-edit overlay (the node itself
 *     is the editor now).
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'

const CANVAS_ROOT = new URL('../../admin/pages/site/canvas/CanvasRoot.tsx', import.meta.url)
const NODE_RENDERER = new URL('../../admin/pages/site/canvas/NodeRenderer.tsx', import.meta.url)
const KEYBOARD_SHORTCUTS = new URL('../../admin/pages/site/canvas/useCanvasKeyboardShortcuts.ts', import.meta.url)
const IFRAME_FRAME_SURFACE = new URL('../../admin/pages/site/canvas/IframeFrameSurface.tsx', import.meta.url)
const BREAKPOINT_FRAME = new URL('../../admin/pages/site/canvas/BreakpointFrame.tsx', import.meta.url)
const CONTEXTS = new URL('../../admin/pages/site/canvas/CanvasContexts.ts', import.meta.url)

describe('inline text editing wiring (in-place contentEditable)', () => {
  it('CanvasRoot starts a session on node double-click, gated to design mode', () => {
    const src = readFileSync(CANVAS_ROOT, 'utf-8')
    expect(src).toContain('startInlineEdit')
    expect(src).toContain('permissions.canEditContent')
  })

  it('the double-click context channel carries the originating breakpoint', () => {
    const src = readFileSync(CONTEXTS, 'utf-8')
    expect(src).toContain('onNodeDoubleClick: (nodeId: string, e: MouseEvent, breakpointId?: string) => void')
  })

  it('NodeRenderer builds an InlineEditBinding for the edited node in the session frame', () => {
    const src = readFileSync(NODE_RENDERER, 'utf-8')
    // Edits flow live: read the contentEditable text back, commit through the store.
    expect(src).toContain('const inlineEditBinding: InlineEditBinding | undefined = isInlineEditing')
    expect(src).toContain('applyInlineEditValue(readInlineEditableText')
    // Session is scoped to the one frame that owns it.
    expect(src).toContain('s.activeInlineEdit.breakpointId === breakpointId')
  })

  it('NodeRenderer passes inlineEdit to the module component (the element IS the editor)', () => {
    const src = readFileSync(NODE_RENDERER, 'utf-8')
    expect(src).toContain('inlineEdit={inlineEditBinding}')
    // No overlay, no per-frame hidden-text attribute — those were the old design.
    expect(src).not.toContain("'data-instatic-inline-editing'")
    expect(src).not.toContain('InlineTextEditOverlay')
  })

  it('NodeRenderer focuses the now-editable element on session start via a layout effect', () => {
    const src = readFileSync(NODE_RENDERER, 'utf-8')
    expect(src).toContain('useLayoutEffect(() => {')
    expect(src).toContain('el.focus()')
  })

  it('the canvas keyboard handler bails while an inline edit is active', () => {
    const src = readFileSync(KEYBOARD_SHORTCUTS, 'utf-8')
    expect(src).toContain('if (useEditorStore.getState().activeInlineEdit) return')
  })

  it('the iframe key-forwarding stands down while an inline edit is active', () => {
    // The edited element lives in the iframe; IframeFrameSurface forwards its
    // keystrokes to the parent document. Forwarding mid-edit would let native
    // parent handlers (undo/redo, zoom, panel rail, space-pan) fire on the
    // clone — the worst being Cmd+Z reverting the whole session in the store
    // while the DOM keeps the text. The forward layer must bail during a session
    // so the spacebar types a space and Cmd+Z is the element's own text undo.
    const src = readFileSync(IFRAME_FRAME_SURFACE, 'utf-8')
    expect(src).toContain('if (useEditorStore.getState().activeInlineEdit) return')
  })

  it('BreakpointFrame no longer mounts an inline-edit overlay', () => {
    const src = readFileSync(BREAKPOINT_FRAME, 'utf-8')
    expect(src).not.toContain('InlineTextEditOverlay')
    // The selection-ring overlay is still mounted — it is a different component.
    expect(src).toContain('<BreakpointSelectionOverlay')
  })
})
