/**
 * useIframeInputRelay — bridges keyboard and pointer input out of a design
 * frame's iframe document into the parent editor document.
 *
 * Owned by `IframeFrameSurface`; one relay per mounted frame. It covers:
 *   - keyboard shortcut forwarding (and the live-frame history subset),
 *   - Space / middle-button / Hand tool pans that start over the frame,
 *   - pointer forwarding for parent-doc canvas drags crossing the frame,
 *   - the Hand tool's grab cursor and tap suppression inside the frame.
 */

import { useEffect, type RefObject } from 'react'
import { useEditorStore } from '@site/store/store'
import { iframeLocalPointToParentClientPoint } from './iframeEventCoordinates'
import { setIframeCanvasToolFlag } from './iframeBodyReset'
import {
  isCanvasSpacePanActive,
  setCanvasSpacePanActive,
  shouldStartCanvasPointerPan,
} from './canvasPanInput'
import { canvasHistoryCommand } from './useCanvasHistoryShortcuts'

interface IframeInputRelayOptions {
  iframeDoc: Document | null
  iframeRef: RefObject<HTMLIFrameElement | null>
  /** Live frames scroll natively: only editor history keys are relayed. */
  isLive: boolean
}

export function useIframeInputRelay({ iframeDoc, iframeRef, isLive }: IframeInputRelayOptions): void {
  // ── Hand tool cursor ────────────────────────────────────────────────────
  // The frame's chrome CSS forces `cursor: default` on every element; this
  // flag switches it to a grab cursor while the Hand tool is active.
  const handToolActive = useEditorStore((s) => s.canvasMode === 'pan')
  useEffect(() => {
    if (!iframeDoc || isLive) return
    setIframeCanvasToolFlag(iframeDoc, handToolActive)
    return () => setIframeCanvasToolFlag(iframeDoc, false)
  }, [iframeDoc, isLive, handToolActive])

  // ── Forward pointer events for canvas pan gestures + parent-doc canvas drags ────
  // The canvas pan gesture (useCanvas via @use-gesture) and the canvas
  // parent-doc canvas drag handlers both live in the parent document
  // and rely on `window` pointer events. Two scenarios need to cross
  // the iframe boundary from inside the iframe back to the parent:
  //
  //   1. A pan that starts over a frame: Space + left-drag (Figma
  //      convention), middle-drag, or a left-drag while the Hand tool
  //      (`canvasMode === 'pan'`) is active.
  //   2. An active canvas drag started outside the iframe (selection
  //      toolbar handle, media panel asset, etc.). The
  //      pointer down fires in the parent, then as the cursor enters an
  //      iframe its pointermove/up events go to the iframe instead of
  //      bubbling up to `window`. Canvas drag hooks set
  //      `data-instatic-canvas-dragging` on `<html>` so each iframe knows to
  //      forward pointermove / up / cancel events while the drag is in
  //      flight. The drag id is also stashed so we can mint forwarded
  //      events with the matching pointerId.
  //
  // For (1) we mirror the spacebar tracking that lives inside `useCanvas`
  // but install it on the iframe document so the iframe knows whether
  // space is currently held. When a pan pointerdown fires, we (a) forward
  // the event so the canvas pan handler sees it, and (b) swallow the
  // original so it never reaches module selection logic. The pointer
  // listeners run in the capture phase so they beat React's handlers,
  // which listen on the frame's root container below the document.
  useEffect(() => {
    if (!iframeDoc) return
    const iframe = iframeRef.current
    if (!iframe) return
    let spaceHeld = false
    // Clicking a node to select it focuses this iframe, so every subsequent
    // keystroke is delivered to the iframe document instead of the parent.
    // The editor's global / editor / panel shortcuts are NATIVE listeners on
    // the parent `window` (spotlight ⌘K, save ⌘S) and parent `document`
    // (panel toggles, undo/redo) — none of which see events that fire inside
    // an iframe. We bridge them by re-dispatching a clone on the parent
    // `document`: it reaches every `document`-level listener at the target
    // and every `window`-level listener during capture/bubble.
    //
    // We deliberately dispatch on `document`, NOT on the iframe element. The
    // global shortcut dispatcher and canvas-level native bridge both listen
    // in the parent document; dispatching here keeps the clone out of the
    // iframe document so this listener never sees it again (no loop).
    const parentDocument = iframe.ownerDocument
    const forwardKeyboard = (e: KeyboardEvent) => {
      const forwarded = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: e.key,
        code: e.code,
        location: e.location,
        repeat: e.repeat,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      })
      parentDocument.dispatchEvent(forwarded)
      // If a parent handler claimed the shortcut (e.g. ⌘K, ⌘S), suppress the
      // iframe's own default for the original key so the browser doesn't also
      // act on it (e.g. native ⌘S save dialog).
      if (forwarded.defaultPrevented) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    // Live frames scroll natively. Relay editor history while leaving typing,
    // navigation and gestures in the preview document.
    if (isLive) {
      const onHistoryKeyDown = (e: KeyboardEvent) => {
        if (canvasHistoryCommand(e) && !useEditorStore.getState().activeInlineEdit) forwardKeyboard(e)
      }
      iframeDoc.addEventListener('keydown', onHistoryKeyDown)
      return () => iframeDoc.removeEventListener('keydown', onHistoryKeyDown)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      // While inline text editing, the contentEditable node owns the keyboard.
      // Stand the whole canvas key layer down: don't track space-pan, don't
      // block Tab, and DON'T forward the keystroke to the parent document.
      // Forwarding re-dispatches a clone on `document`, where native handlers
      // (undo/redo, zoom reset, panel rail, space-pan) guard only on
      // `e.target.isContentEditable` — but the clone's target is `document`,
      // not the cross-realm editing element, so they'd fire mid-edit. The
      // worst is Cmd+Z running the store `undo()` (reverting the whole
      // coalesced session) while the DOM keeps the text — store/DOM diverge.
      // The element's own React onKeyDown still owns Escape/Enter.
      if (useEditorStore.getState().activeInlineEdit) return
      if (e.code === 'Space' && !e.repeat) {
        spaceHeld = true
        setCanvasSpacePanActive(parentDocument, 'iframe', true)
      }
      // Block Tab navigation inside the canvas iframe. The author is
      // designing, not using, the page — letting Tab walk through
      // link / button controls inside the iframe surface the browser's
      // default focus outline and traps the keyboard inside the
      // preview. The canvas exposes its own keyboard model
      // (arrow keys / Cmd+navigation) at the parent level.
      if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      forwardKeyboard(e)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeld = false
        setCanvasSpacePanActive(parentDocument, 'iframe', false)
      }
    }
    iframeDoc.addEventListener('keydown', onKeyDown)
    iframeDoc.addEventListener('keyup', onKeyUp)

    const forwardPointer = (e: PointerEvent, overridePointerId?: number) => {
      const rect = iframe.getBoundingClientRect()
      const clientPoint = iframeLocalPointToParentClientPoint(
        rect,
        { width: iframe.clientWidth, height: iframe.clientHeight },
        { x: e.clientX || 0, y: e.clientY || 0 },
      )
      const forwarded = new PointerEvent(e.type, {
        bubbles: true,
        cancelable: true,
        pointerId: overridePointerId ?? e.pointerId,
        pointerType: e.pointerType,
        button: e.button,
        buttons: e.buttons,
        clientX: clientPoint.x,
        clientY: clientPoint.y,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      })
      iframe.dispatchEvent(forwarded)
    }
    const isCanvasDragActive = (): { pointerId: number } | null => {
      const html = iframe.ownerDocument?.documentElement
      if (!html) return null
      if (html.dataset.instaticCanvasDragging !== '1') return null
      const id = Number(html.dataset.instaticCanvasDraggingPointerId ?? NaN)
      return Number.isFinite(id) ? { pointerId: id } : { pointerId: 0 }
    }
    // True while a pan gesture started inside this iframe is still in
    // flight (Space + left-drag, middle-drag, or a Hand tool left-drag). We
    // start a pan on pointerdown when the conditions match and keep
    // forwarding every subsequent pointermove / pointerup for the same
    // pointerId until the button comes back up.
    // This is the only way to know that a stray pointermove is "part of an
    // active pan" — `e.buttons` is 0 on the final pointerup, and using
    // `e.button === 0` to detect "left is down during move" matches every
    // casual mouse motion (because pointermove always reports `button` as 0).
    // Tracking explicitly is the only correct option.
    let panPointerId: number | null = null
    const isHandToolActive = () => useEditorStore.getState().canvasMode === 'pan'
    const isPanStartPointer = (e: PointerEvent): boolean => {
      return shouldStartCanvasPointerPan(e, {
        primaryButtonPans:
          spaceHeld || isCanvasSpacePanActive(parentDocument) || isHandToolActive(),
      })
    }
    const maybeForward = (e: PointerEvent) => {
      // (2) An external canvas drag is in progress — forward move/up/
      // cancel so the parent's `window` listeners keep ticking.
      // pointerdown is excluded: the iframe never originates the drag,
      // and forwarding the first iframe-internal pointerdown would
      // confuse the parent's session state.
      const dragSignal = isCanvasDragActive()
      if (dragSignal && (e.type === 'pointermove' || e.type === 'pointerup' || e.type === 'pointercancel')) {
        // The iframe-internal event is harmless on its own (no selection
        // logic listens for raw pointermove inside the iframe), so we
        // don't swallow it — but we do forward it to the parent doc with
        // the original drag's pointerId so the session-id check in
        // the parent drag session is consistent.
        forwardPointer(e, dragSignal.pointerId)
        return
      }

      if (e.type === 'pointerdown' && isPanStartPointer(e)) {
        panPointerId = e.pointerId
        // Swallow the original so the click doesn't also trigger module
        // selection while the user is intentionally panning.
        e.preventDefault()
        e.stopPropagation()
        forwardPointer(e)
        return
      }

      if (panPointerId !== null && e.pointerId === panPointerId) {
        if (e.type === 'pointermove') {
          e.preventDefault()
          e.stopPropagation()
          forwardPointer(e)
          return
        }
        if (e.type === 'pointerup' || e.type === 'pointercancel') {
          forwardPointer(e)
          panPointerId = null
          return
        }
      }
    }
    // The Hand tool never selects or edits: swallow the click / double-click
    // (inline-edit entry) a press would otherwise deliver to the page, and
    // block native image/link drags that would cancel the pointer stream.
    const swallowWhileHandTool = (e: Event) => {
      if (!isHandToolActive()) return
      e.preventDefault()
      e.stopPropagation()
    }
    iframeDoc.addEventListener('pointerdown', maybeForward, { capture: true })
    iframeDoc.addEventListener('pointermove', maybeForward, { capture: true })
    iframeDoc.addEventListener('pointerup', maybeForward, { capture: true })
    iframeDoc.addEventListener('pointercancel', maybeForward, { capture: true })
    iframeDoc.addEventListener('click', swallowWhileHandTool, { capture: true })
    iframeDoc.addEventListener('dblclick', swallowWhileHandTool, { capture: true })
    iframeDoc.addEventListener('dragstart', swallowWhileHandTool, { capture: true })
    return () => {
      setCanvasSpacePanActive(parentDocument, 'iframe', false)
      iframeDoc.removeEventListener('keydown', onKeyDown)
      iframeDoc.removeEventListener('keyup', onKeyUp)
      iframeDoc.removeEventListener('pointerdown', maybeForward, { capture: true })
      iframeDoc.removeEventListener('pointermove', maybeForward, { capture: true })
      iframeDoc.removeEventListener('pointerup', maybeForward, { capture: true })
      iframeDoc.removeEventListener('pointercancel', maybeForward, { capture: true })
      iframeDoc.removeEventListener('click', swallowWhileHandTool, { capture: true })
      iframeDoc.removeEventListener('dblclick', swallowWhileHandTool, { capture: true })
      iframeDoc.removeEventListener('dragstart', swallowWhileHandTool, { capture: true })
    }
  }, [iframeDoc, iframeRef, isLive])
}
