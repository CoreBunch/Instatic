/**
 * InlineTextEditOverlay — the canvas inline text editor (double-click to edit).
 *
 * A real `<textarea>`/`<input>` in the PARENT document, portaled into the
 * canvas root and positioned over the edited node inside the breakpoint
 * iframe — no cross-frame focus negotiation, which is what made the old
 * in-iframe contentEditable editor unshippable (see
 * docs/features/canvas-iframe-per-frame.md). Mirrors the
 * BreakpointSelectionOverlay portal + RAF-tracking pattern so the field
 * follows pan / zoom / reflow.
 *
 * Session state lives in the editor store (`activeInlineEdit` — one session
 * globally, owned by the breakpoint frame that was double-clicked). Every
 * keystroke commits live through `applyInlineEditValue` → `updateNodeProps`,
 * so all OTHER frames preview the change while THIS frame hides the node's
 * own text (`data-instatic-inline-editing` in NodeRenderer + the
 * CANVAS_CHROME_CSS rule in iframeBodyReset.ts).
 *
 * End-of-session semantics (mirrors the removed in-iframe editor):
 *   - Enter / Cmd+Enter / Ctrl+Enter → commit + close. base.text does not
 *     render newlines (its render() interpolates raw text into HTML where
 *     whitespace collapses), so plain Enter commits in BOTH modes;
 *     Shift+Enter in multiline falls through to the native newline for
 *     authors who add `white-space: pre-wrap` via their own CSS.
 *   - Blur → commit + close.
 *   - Escape → cancel (single undo of the coalesced burst iff committed).
 *   - Node unmounted / rect unmeasurable / frame unmount → force-close.
 */
import { use, useEffect, useEffectEvent, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore } from '@site/store/store'
import { CanvasViewportActionsContext } from './CanvasContexts'
import { escapeCssAttributeValue } from './canvasNodeLookup'
import { measureCanvasElementRect, mirrorInlineEditTypography } from './canvasOverlayGeometry'
import styles from './InlineTextEditOverlay.module.css'

interface InlineTextEditOverlayProps {
  /**
   * The breakpoint frame this overlay belongs to — it only renders when the
   * active session was started from this frame.
   */
  breakpointId: string
  /** The frame's iframe element; rect + typography are measured inside it. */
  iframeElement: HTMLIFrameElement | null
}

export function InlineTextEditOverlay({ breakpointId, iframeElement }: InlineTextEditOverlayProps) {
  const session = useEditorStore((s) =>
    s.activeInlineEdit?.breakpointId === breakpointId ? s.activeInlineEdit : null,
  )
  const applyInlineEditValue = useEditorStore((s) => s.applyInlineEditValue)
  const endInlineEdit = useEditorStore((s) => s.endInlineEdit)
  const cancelInlineEdit = useEditorStore((s) => s.cancelInlineEdit)
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const ringRef = useRef<HTMLDivElement | null>(null)
  const viewportActions = use(CanvasViewportActionsContext)

  // Stable per-session identity. The session OBJECT is replaced when
  // `committed` flips on the first keystroke — keying the effect (and the
  // field's defaultValue reset) on the object would re-run focus +
  // select-all mid-typing and clobber the user's caret.
  const sessionKey = session ? `${session.nodeId}:${session.prop}` : null

  // Each RAF tick reads the freshest session / iframe / canvas root from the
  // latest render closure — same pattern as BreakpointSelectionOverlay.
  const tickOnce = useEffectEvent(() => {
    const field = fieldRef.current
    if (!field || !session || !iframeElement) return
    const target =
      iframeElement.contentDocument?.querySelector<HTMLElement>(
        `[data-node-id="${escapeCssAttributeValue(session.nodeId)}"]`,
      ) ?? null
    const canvasRoot = viewportActions?.canvasRootRef.current ?? null
    const rect = measureCanvasElementRect(target, iframeElement, canvasRoot)
    if (!rect || !target) {
      // Node unmounted mid-session (deleted / hidden / page recomposed).
      // Keystrokes already committed live — just close the session.
      endInlineEdit()
      return
    }
    field.style.transform = `translate(${rect.x}px, ${rect.y}px)`
    field.style.width = `${rect.width}px`
    field.style.height = `${rect.height}px`
    mirrorInlineEditTypography(field, target, iframeElement)
    // The affordance ring tracks the NODE's own box (like the normal selection
    // ring), independent of the field growing below for the no-scroll fix.
    const ring = ringRef.current
    if (ring) {
      ring.style.transform = `translate(${rect.x}px, ${rect.y}px)`
      ring.style.width = `${rect.width}px`
      ring.style.height = `${rect.height}px`
    }
    // A <textarea> scrolls its own content to keep the caret visible whenever
    // the text is taller than the box — which happens for any node with
    // line-height < 1 (negative leading makes glyphs overflow the line boxes,
    // exactly how the block node renders them with overflow:visible). Grow the
    // field to its full content height (measured AFTER typography is mirrored)
    // so there is nothing to scroll, then pin any residual offset. Without this
    // the text shifts as the caret moves between lines. `scrollHeight` is the
    // greater of content and box height, so single-line / line-height ≥ 1 nodes
    // leave the height at the node's rect.
    const contentHeight = field.scrollHeight
    if (contentHeight > rect.height) field.style.height = `${contentHeight}px`
    if (field.scrollTop !== 0) field.scrollTop = 0
    if (field.scrollLeft !== 0) field.scrollLeft = 0
  })

  // Position + typography RAF loop, armed only while this frame owns the
  // session. The first tick runs synchronously so the field never flashes at
  // (0,0); focus + select-all mirror the removed in-iframe editor's
  // enter-edit-mode behaviour (commit 934df7d4).
  useEffect(() => {
    if (!sessionKey || !iframeElement) return
    tickOnce()
    const field = fieldRef.current
    field?.focus()
    field?.select()
    let frame = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      tickOnce()
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [sessionKey, iframeElement])

  // Force-close when this frame unmounts mid-session (breakpoint collapsed /
  // removed, canvas switched to live mode). Imperative store read — the
  // cleanup must see the freshest session, not the one captured at mount.
  useEffect(() => {
    return () => {
      const current = useEditorStore.getState()
      if (current.activeInlineEdit?.breakpointId === breakpointId) {
        current.endInlineEdit()
      }
    }
  }, [breakpointId])

  if (!session) return null

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    applyInlineEditValue(e.currentTarget.value)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // Keep EVERY keystroke out of the canvas-root shortcut layer — Escape
    // there clears the selection / exits VC mode, Cmd/Ctrl+D duplicates the
    // node, and zoom keys fire. The field owns typing entirely.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelInlineEdit()
      return
    }
    if (e.key === 'Enter') {
      // Plain Enter commits in BOTH modes — base.text doesn't render
      // newlines (whitespace collapses in the published HTML). Shift+Enter
      // in multiline inserts a native newline for authors who opt into
      // `white-space: pre-wrap` with their own CSS.
      if (session.multiline && e.shiftKey && !e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      endInlineEdit()
    }
  }

  // Keystrokes already committed live — blur just closes the session.
  const handleBlur = () => endInlineEdit()

  // Clicks/drags inside the field must not reach the canvas root: its
  // onClick clears the selection and the gesture layer would treat the
  // text-selection drag as a pan.
  const stopMouse = (e: React.SyntheticEvent) => e.stopPropagation()

  const canvasRoot = viewportActions?.canvasRootRef.current ?? null
  const portalTarget = canvasRoot ?? document.body
  const positionMode = canvasRoot ? 'scoped' : 'fixed'

  const fieldProps = {
    className: styles.field,
    defaultValue: session.initialValue,
    'aria-label': 'Edit text inline',
    'data-testid': 'canvas-inline-edit-field',
    spellCheck: false,
    onChange: handleChange,
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
    onPointerDown: stopMouse,
    onClick: stopMouse,
    onDoubleClick: stopMouse,
    onContextMenu: stopMouse,
  }

  return createPortal(
    <div className={styles.layer} data-canvas-inline-edit-mode={positionMode}>
      <div className={styles.ring} ref={ringRef} aria-hidden="true" />
      {session.multiline ? (
        <textarea
          key={sessionKey}
          {...fieldProps}
          ref={(el) => {
            fieldRef.current = el
          }}
          rows={1}
        />
      ) : (
        <input
          key={sessionKey}
          {...fieldProps}
          ref={(el) => {
            fieldRef.current = el
          }}
          type="text"
        />
      )}
    </div>,
    portalTarget,
  )
}
