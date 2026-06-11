/**
 * IframeFrameSurface — renders one breakpoint frame inside its own iframe so
 * the canvas DOM matches the published page's DOM exactly.
 *
 * Why an iframe per frame?
 * ────────────────────────
 * The editor used to render each breakpoint frame as a `<div className=
 * "viewport">` directly inside the editor's document. That gave us "free"
 * event handling and shared CSS, but it created two structural mismatches
 * between canvas and published HTML:
 *
 *   1. `<body>` was the editor's body, so user CSS like
 *      `body { background: black; }` painted the editor chrome.
 *   2. Every authored element was wrapped in a `<div class="nodeWrapper">`
 *      for editor plumbing. CSS combinators (`>`, `+`, `~`, `:nth-child()`)
 *      couldn't traverse the wrappers, so authored direct-child / sibling
 *      relationships didn't match in the canvas.
 *
 * The iframe gives the page tree its own document, with its own real
 * `<body>` — user CSS works exactly as it does on the published site. No
 * scoping, no rewriting, no impedance mismatch. Each module also spreads
 * `nodeWrapperProps` (data-node-id, click/hover/keyboard handlers, …)
 * directly onto its own root tag, so there are no `display: contents`
 * NodeWrapper divs sitting between authored elements either — CSS
 * combinators (`>`, `+`, `~`, `:nth-child()`) match the same authored DOM
 * the publisher emits.
 *
 * How it works
 * ────────────
 *  - The iframe boots with an empty HTML skeleton via `srcDoc`.
 *  - On the iframe's `load` event we capture `contentDocument` into state.
 *  - The children passed to this component are mounted into the iframe's
 *    `<body>` via `createPortal`. React synthetic events bubble through
 *    the React tree (not the DOM tree), so click/hover/keyboard handlers
 *    attached in NodeRenderer still fire — the React fiber sees these as
 *    same-tree events.
 *  - `ClassStyleInjector` and `UserStylesheetInjector` are mounted with
 *    `targetDocument={iframeDoc}` so the class registry CSS and user
 *    stylesheets land in the iframe's `<head>`.
 *  - `data-breakpoint-id` is set on the iframe's `<body>` so the
 *    per-breakpoint class CSS (which uses `[data-breakpoint-id="..."]
 *    .myClass` selectors) matches inside the iframe.
 *
 * What's NOT in this component (yet):
 *  - Per-iframe `getComputedStyle` for code outside the iframe that
 *    measures elements (selection overlay handles its own iframe-rect
 *    translation; other callers may need updates).
 *
 * Cross-iframe drag relay (canvas reorder)
 * ────────────────────────────────────────
 * The canvas reorder drag (`useCanvasReorderDrag`) starts on the selection
 * toolbar's drag handle in the parent doc, but the cursor inevitably
 * crosses into an iframe partway through. Left-click pointer events
 * inside the iframe never bubble to the parent's `window`, so the parent's
 * pointermove / up / cancel listeners go silent the moment the cursor
 * enters a frame. To fix that, `useCanvasReorderDrag` sets
 * `data-instatic-canvas-dragging` and `data-instatic-canvas-dragging-pointer-id` on
 * the parent's `<html>` while a drag is in flight. Every iframe reads
 * those flags inside its pointer handler and, when set, forwards the
 * three pointer event types to the parent (using the original drag's
 * pointerId so the parent's session-id assumptions still line up).
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@ui/cn'
import { ClassStyleInjector } from './ClassStyleInjector'
import { UserStylesheetInjector } from './UserStylesheetInjector'
import { EditorChromeInjector } from './EditorChromeInjector'
import { RuntimeScriptInjector } from './RuntimeScriptInjector'
import type { InjectableRuntimeScript } from './useRuntimeScriptBuild'
import { useIframeCursorBridge } from './useIframeCursorBridge'
import { iframeWheelPointToParentClientPoint } from './iframeWheelForwarding'
import { useCanvasFormControlSuppression } from './useCanvasFormControlSuppression'
import { CANVAS_VIEWPORT_HEIGHT, type CanvasViewport } from './resolveViewportUnits'
import { useIframeFrameAutoHeight } from './useIframeFrameAutoHeight'
import { applyIframeBodyReset, type IframeInteraction } from './iframeBodyReset'
import { useEditorStore } from '@site/store/store'
import styles from './IframeFrameSurface.module.css'

const IFRAME_SRC_DOC = '<!doctype html><html><head></head><body></body></html>'

/** Stable empty list so a script-less frame doesn't churn the injector's deps. */
const EMPTY_RUNTIME_SCRIPTS: InjectableRuntimeScript[] = []

/**
 * Elements whose default click/activation navigates the frame. Anchors and
 * image-maps cover link navigation; form submission is cancelled separately
 * via a `submit` listener, so a default-typed submit button inside a form is
 * covered there even though it isn't matched here.
 */
const NAVIGABLE_SELECTOR = 'a[href], area[href], button[type="submit"], input[type="submit"], input[type="image"]'

/**
 * Cross-realm-safe "is this an Element?" check. The canvas iframe is same-origin
 * but a different realm, so `target instanceof Element` (the host realm's class)
 * is false for nodes inside the iframe — duck-type `closest` instead. Mirrors
 * the same helper in `NodeRenderer`.
 */
function isElementLike(value: EventTarget | null): value is Element {
  return value != null && typeof (value as { closest?: unknown }).closest === 'function'
}

interface IframeFrameSurfaceProps {
  /** Stable id used to tag the iframe's `<body>` with `data-breakpoint-id`. */
  breakpointId: string
  /** Logical viewport width in px; drives the iframe's CSS width. */
  width: number
  className?: string
  style?: CSSProperties
  /**
   * Click handler delegated to the iframe's `<body>`. The original frame
   * had its onClick on the viewport `<div>`; we replicate that on the body
   * so clicking the empty area still activates the breakpoint.
   */
  onClick?: () => void
  /** Cursor movement inside the iframe, translated by callers as needed. */
  onCursorMove?: (event: MouseEvent) => void
  /** Cursor leave from the iframe element. */
  onCursorLeave?: () => void
  /** Page tree React subtree to mount inside the iframe's body. */
  children: ReactNode
  /**
   * `data-*` attributes forwarded onto the iframe element itself. The
   * outgoing `data-breakpoint-id` lives on the iframe's `<body>` (so it can
   * be a target of the canvas's `[data-breakpoint-id]`-scoped CSS), but
   * the editor sometimes wants identifiers on the iframe wrapper too —
   * e.g. testids that the agent-browser can target without crossing the
   * iframe boundary.
   */
  dataAttrs?: Record<string, string | undefined>
  /** Interaction model — see {@link IframeInteraction}. Defaults to 'canvas'. */
  interaction?: IframeInteraction
  /**
   * Double-click handler for read-only composed regions (template chrome,
   * inlined components, outlet previews). Resolved from the nearest ancestor
   * carrying `data-instatic-readonly-*` markers; opens that source for editing.
   */
  onReadonlyOpen?: (kind: 'page' | 'component', id: string) => void
  /**
   * Bundled runtime scripts to execute inside the frame. Empty/undefined runs
   * nothing — the frame stays a pure render. Same in both interaction modes
   * (the "Run scripts" toggle drives this), so authored behaviour can run
   * alongside the live editor.
   */
  runtimeScripts?: InjectableRuntimeScript[]
}

export interface IframeFrameSurfaceHandle {
  /** The iframe element itself. `null` until the iframe mounts. */
  iframeElement: HTMLIFrameElement | null
  /** The iframe's contentDocument. `null` until the iframe has loaded. */
  contentDocument: Document | null
  /** Convenience: the iframe's body. `null` until loaded. */
  contentBody: HTMLBodyElement | null
}

type IframeWithCleanup = HTMLIFrameElement & { _instaticCleanup?: () => void }

export const IframeFrameSurface = forwardRef<IframeFrameSurfaceHandle, IframeFrameSurfaceProps>(
  function IframeFrameSurface(
    {
      breakpointId,
      width,
      className,
      style,
      onClick,
      onCursorMove,
      onCursorLeave,
      children,
      dataAttrs,
      interaction = 'canvas',
      runtimeScripts,
      onReadonlyOpen,
    },
    ref,
    ) {
      const isLive = interaction === 'live'
      const iframeRef = useRef<HTMLIFrameElement | null>(null)
      const [iframeDoc, setIframeDoc] = useState<Document | null>(null)

    useIframeCursorBridge(iframeRef, iframeDoc, { onCursorMove, onCursorLeave })
    useCanvasFormControlSuppression(iframeDoc, { breakpointId, enabled: !isLive })
    useIframeFrameAutoHeight({ iframeRef, iframeDoc, isLive })

    // Bridge the iframe handle out to the parent (selection overlay reads
    // `iframeElement` to translate inside-iframe rects into editor coordinates).
    useImperativeHandle(
      ref,
      () => ({
        iframeElement: iframeRef.current,
        contentDocument: iframeDoc,
        contentBody: (iframeDoc?.body ?? null) as HTMLBodyElement | null,
      }),
      [iframeDoc],
    )

    // Wire up the iframe document once it's ready. Capture both onLoad and
    // the synchronous `contentDocument` path: `srcDoc` parses immediately so
    // contentDocument is often already populated by the time React commits
    // the iframe element; we still listen for `load` as a fallback in case
    // the browser deferred parsing.
    const attachIframeDoc = (iframe: HTMLIFrameElement | null) => {
      const previousIframe = iframeRef.current as IframeWithCleanup | null
      if (previousIframe && previousIframe !== iframe) {
        previousIframe._instaticCleanup?.()
        previousIframe._instaticCleanup = undefined
      }
      iframeRef.current = iframe
      if (!iframe) {
        setIframeDoc(null)
        return
      }
      const tryCapture = () => {
        const doc = iframe.contentDocument
        if (doc && doc.readyState !== 'loading') setIframeDoc(doc)
      }
      tryCapture()
      iframe.addEventListener('load', tryCapture)
      // Stash the cleanup on the ref so React's ref-callback contract (the
      // function may be called again with null on unmount) doesn't leak
      // listeners.
      const cleanableIframe = iframe as IframeWithCleanup
      cleanableIframe._instaticCleanup = () => {
        iframe.removeEventListener('load', tryCapture)
        cleanableIframe._instaticCleanup = undefined
      }
    }

    // Tag the iframe body with `data-breakpoint-id` (matches the existing
    // canvasClassCss selector `[data-breakpoint-id="..."] .myClass`) and
    // wire the empty-frame click handler. Re-runs when the document or
    // handler change.
    //
    // We also break the `:where(html, body) { height: 100% }` reset rule
    // for the canvas iframe context. The published page wants body filling
    // the viewport (so footer stickies to bottom on short pages); the
    // canvas iframe is a Figma-like frame that should be content-sized, with
    // a fixed canvas viewport floor on the body. Letting body inherit 100%
    // creates a feedback loop where the iframe sizes to body which sizes to
    // iframe and the frame never shrinks. Both `html` and `body` styles win
    // against `:where()` (zero-specificity) so the override is safe.
    useEffect(() => {
      if (!iframeDoc?.body) return
      applyIframeBodyReset(iframeDoc, breakpointId, interaction)
      if (!onClick) return
      // Empty-frame click: ONLY fire when the click target is the body
      // itself (not a child node bubbling up). Without this guard, every
      // single click anywhere in the iframe — including clicks that the
      // canvas already routed through NodeRenderer's stopPropagation
      // logic — would re-trigger `onActivate`. React's `stopPropagation()`
      // from the child's onClick reaches React's delegated listener but
      // doesn't stop this native bubble-phase listener (they were
      // attached in different code paths, in different orders).
      const handler = (e: MouseEvent) => {
        if (e.target !== iframeDoc.body) return
        onClick()
      }
      iframeDoc.body.addEventListener('click', handler)
      return () => {
        iframeDoc.body.removeEventListener('click', handler)
      }
    }, [iframeDoc, breakpointId, onClick, interaction])

    // ── Navigation guard ─────────────────────────────────────────────────
    // The canvas iframe is an EDITING surface, never a browsing surface.
    // Authored content, read-only template chrome, and inlined Visual
    // Components all render real `<a href>` / `<form>` elements; clicking one
    // would navigate the frame and load the whole site inside the editor. A
    // capture-phase `preventDefault` cancels every default navigation
    // regardless of which subtree the element lives in, while deliberately NOT
    // calling `stopPropagation` so React's synthetic click handlers still run
    // and node selection keeps working. Applies in both interaction modes —
    // neither the design canvas nor the live/preview frame is a real
    // navigation target.
    useEffect(() => {
      if (!iframeDoc) return
      const blockNavigation = (event: Event) => {
        const target = event.target
        if (!isElementLike(target)) return
        if (!target.closest(NAVIGABLE_SELECTOR)) return
        event.preventDefault()
      }
      const blockSubmit = (event: Event) => {
        event.preventDefault()
      }
      iframeDoc.addEventListener('click', blockNavigation, true)
      iframeDoc.addEventListener('auxclick', blockNavigation, true)
      iframeDoc.addEventListener('submit', blockSubmit, true)
      return () => {
        iframeDoc.removeEventListener('click', blockNavigation, true)
        iframeDoc.removeEventListener('auxclick', blockNavigation, true)
        iframeDoc.removeEventListener('submit', blockSubmit, true)
      }
    }, [iframeDoc])

    // ── Read-only region open ────────────────────────────────────────────
    // Double-clicking read-only composed content (template chrome, an inlined
    // component, an outlet preview) opens its source document for editing.
    // The nearest ancestor carrying `data-instatic-readonly-*` markers names
    // the source; editable nodes carry no such markers, so their own
    // double-click (enter / inline-edit) is untouched.
    useEffect(() => {
      if (!iframeDoc || !onReadonlyOpen) return
      const handleDblClick = (event: MouseEvent) => {
        const target = event.target
        if (!isElementLike(target)) return
        const region = target.closest('[data-instatic-readonly-id]')
        if (!region) return
        const id = region.getAttribute('data-instatic-readonly-id')
        const kind = region.getAttribute('data-instatic-readonly-kind')
        if (!id || (kind !== 'page' && kind !== 'component')) return
        event.preventDefault()
        event.stopPropagation()
        onReadonlyOpen(kind, id)
      }
      iframeDoc.addEventListener('dblclick', handleDblClick, true)
      return () => {
        iframeDoc.removeEventListener('dblclick', handleDblClick, true)
      }
    }, [iframeDoc, onReadonlyOpen])

    // ── Forward wheel events to the canvas gesture layer ─────────────────
    // Without this, scrolling the wheel while the cursor is over an iframe
    // does nothing — the iframe document doesn't propagate wheel events to
    // the parent. The canvas pan/zoom gesture handlers live in the parent
    // document, attached to the canvas root via useGesture; they need
    // wheel events at the parent's coordinate system. We forward by
    // listening inside the iframe and re-dispatching a new WheelEvent on
    // the iframe element itself (in the parent doc), so it bubbles to the
    // canvas root and useGesture's handler picks it up.
    useEffect(() => {
      // Live frames scroll natively — no pan to forward to.
      if (isLive) return
      if (!iframeDoc) return
      const iframe = iframeRef.current
      if (!iframe) return
      const onWheel = (e: WheelEvent) => {
        // Prevent the iframe from doing its own scroll (should be a no-op
        // since we sized the iframe to content, but defensive).
        e.preventDefault()
        const rect = iframe.getBoundingClientRect()
        // The iframe event reports unscaled, iframe-local CSS pixels. The
        // parent canvas needs transformed client pixels so zoom-to-cursor
        // stays anchored under the user's pointer at every canvas scale.
        const clientPoint = iframeWheelPointToParentClientPoint(
          rect,
          { width: iframe.clientWidth, height: iframe.clientHeight },
          { x: e.clientX || 0, y: e.clientY || 0 },
        )
        const forwarded = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaZ: e.deltaZ,
          deltaMode: e.deltaMode,
          clientX: clientPoint.x,
          clientY: clientPoint.y,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
        })
        iframe.dispatchEvent(forwarded)
      }
      // `passive: false` so we can preventDefault on the iframe-internal
      // wheel — otherwise Chrome lets the iframe do its own scroll first.
      iframeDoc.addEventListener('wheel', onWheel, { passive: false })
      return () => {
        iframeDoc.removeEventListener('wheel', onWheel)
      }
    }, [iframeDoc, isLive])

    // ── Forward pointer events for canvas pan gestures + reorder drag ────
    // The canvas pan gesture (useCanvas via @use-gesture) and the canvas
    // reorder drag (useCanvasReorderDrag) both live in the parent document
    // and rely on `window` pointer events. Three scenarios need to cross
    // the iframe boundary from inside the iframe back to the parent:
    //
    //   1. Middle-click drag (`e.button === 1`) — always a pan, regardless
    //      of where the cursor is.
    //   2. Space + left-click drag (Figma convention) — pan when the user
    //      is holding space, even with the cursor over a frame.
    //   3. An active reorder drag started outside the iframe (the
    //      selection toolbar's drag handle lives in the parent doc). The
    //      pointer down fires in the parent, then as the cursor enters an
    //      iframe its pointermove/up events go to the iframe instead of
    //      bubbling up to `window`. `useCanvasReorderDrag` sets
    //      `data-instatic-canvas-dragging` on `<html>` so each iframe knows to
    //      forward pointermove / up / cancel events while the drag is in
    //      flight. The drag id is also stashed so we can mint forwarded
    //      events with the matching pointerId.
    //
    // For (2) we mirror the spacebar tracking that lives inside `useCanvas`
    // but install it on the iframe document so the iframe knows whether
    // space is currently held. When pointerdown fires with space active,
    // we (a) forward the event so the canvas pan handler sees it, and
    // (b) `preventDefault` so the iframe doesn't also send the original
    // pointer event into module selection logic (otherwise a module would
    // get selected while the user was trying to pan).
    useEffect(() => {
      // Pan-gesture / reorder-drag relay is canvas-only. Live frames neither
      // pan nor host the cross-frame reorder drag.
      if (isLive) return
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
      // canvas's own shortcut handler (delete / duplicate / clipboard / Escape)
      // is a React `onKeyDown` on the canvas root, and React already delivers
      // iframe-originated key events to it through the React fiber tree (see
      // docs/features/canvas-iframe-per-frame.md). Dispatching the clone on the
      // iframe element would bubble it through React's root container too and
      // fire those handlers a SECOND time (duplicate twice, delete twice).
      // `document` is above React's root container in the DOM, so the clone is
      // seen only by the native window/document listeners — never re-entering
      // React. The clone also lands in the parent document, so this
      // iframe-document listener never sees it again (no loop).
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
        if (e.code === 'Space' && !e.repeat) spaceHeld = true
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
        if (e.code === 'Space') spaceHeld = false
      }
      iframeDoc.addEventListener('keydown', onKeyDown)
      iframeDoc.addEventListener('keyup', onKeyUp)

      const forwardPointer = (e: PointerEvent, overridePointerId?: number) => {
        const rect = iframe.getBoundingClientRect()
        const clientX = rect.left + (e.clientX || 0)
        const clientY = rect.top + (e.clientY || 0)
        const forwarded = new PointerEvent(e.type, {
          bubbles: true,
          cancelable: true,
          pointerId: overridePointerId ?? e.pointerId,
          pointerType: e.pointerType,
          button: e.button,
          buttons: e.buttons,
          clientX,
          clientY,
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
      // flight (middle-click hold OR space+left-click hold). We start a
      // pan on pointerdown when the conditions match and keep forwarding
      // every subsequent pointermove / pointerup for the same pointerId
      // until the button comes back up. This is the only way to know that
      // a stray pointermove is "part of an active pan" — `e.buttons` is 0
      // on the final pointerup, and using `e.button === 0` to detect "left
      // is down during move" matches every casual mouse motion (because
      // pointermove always reports `button` as 0). Tracking explicitly is
      // the only correct option.
      let panPointerId: number | null = null
      const isPanStartPointer = (e: PointerEvent): boolean => {
        // Middle button down — middle-click pan.
        if (e.button === 1) return true
        // Space + left button down — Figma-style pan.
        if (spaceHeld && e.button === 0) return true
        return false
      }
      const maybeForward = (e: PointerEvent) => {
        // (3) An external reorder drag is in progress — forward move/up/
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
          // useCanvasReorderDrag is consistent.
          forwardPointer(e, dragSignal.pointerId)
          return
        }

        if (e.type === 'pointerdown' && isPanStartPointer(e)) {
          panPointerId = e.pointerId
          // Space + left-click: swallow the original so the click doesn't
          // also trigger module selection. Middle-click never selects
          // anything so it doesn't need swallowing.
          if (spaceHeld && e.button === 0) {
            e.preventDefault()
            e.stopPropagation()
          }
          forwardPointer(e)
          return
        }

        if (panPointerId !== null && e.pointerId === panPointerId) {
          if (e.type === 'pointermove') {
            if (spaceHeld) {
              e.preventDefault()
              e.stopPropagation()
            }
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
      iframeDoc.addEventListener('pointerdown', maybeForward)
      iframeDoc.addEventListener('pointermove', maybeForward)
      iframeDoc.addEventListener('pointerup', maybeForward)
      iframeDoc.addEventListener('pointercancel', maybeForward)
      return () => {
        iframeDoc.removeEventListener('keydown', onKeyDown)
        iframeDoc.removeEventListener('keyup', onKeyUp)
        iframeDoc.removeEventListener('pointerdown', maybeForward)
        iframeDoc.removeEventListener('pointermove', maybeForward)
        iframeDoc.removeEventListener('pointerup', maybeForward)
        iframeDoc.removeEventListener('pointercancel', maybeForward)
      }
    }, [iframeDoc, isLive])

    const dataAttrSpread = dataAttrs
      ? Object.fromEntries(
          Object.entries(dataAttrs).filter(([, v]) => v !== undefined),
        )
      : {}

    // Frame viewport for canvas viewport-unit resolution. Width is the
    // breakpoint width (the iframe's real width); height is a fixed
    // device-like value. Pinning `vh`/`vmax`/… to this stops authored
    // viewport units from feeding the grow-to-content height loop above.
    const viewport: CanvasViewport = { width, height: CANVAS_VIEWPORT_HEIGHT }

    return (
      <>
        <iframe
          ref={attachIframeDoc}
          // `srcDoc` is what creates the iframe document; an empty
          // `<html><body>` so we can portal React content into the body.
          srcDoc={IFRAME_SRC_DOC}
          className={cn(styles.iframe, isLive && styles.iframeLive, className)}
          // Canvas frames are sized to the breakpoint width and grow to content
          // height. Live frames fill the surface-controlled wrapper and scroll
          // internally, so they take 100% in both axes.
          style={isLive ? { ...style, width: '100%', height: '100%' } : { ...style, width: `${width}px` }}
          title={`Canvas frame for ${breakpointId}`}
          {...dataAttrSpread}
          // Allow the same-origin policy so the parent can read/write the
          // iframe's document. `allow-scripts` so authored script modules
          // (and React itself, via portal) can run.
        />
        {iframeDoc &&
          createPortal(
            <>
              {/* Editor-chrome stylesheet — UNLAYERED so it beats @layer user-authored author CSS */}
              <EditorChromeInjector targetDocument={iframeDoc} parentDocument={document} />
              {/* Author CSS — both wrapped in @layer user-authored inside the injectors */}
              <ClassStyleInjector targetDocument={iframeDoc} viewport={viewport} />
              <UserStylesheetInjector targetDocument={iframeDoc} viewport={viewport} />
              {children}
              {/* Runtime scripts (opt-in) run against the node tree mounted
                  above. Empty list = no-op, so this is safe to always mount. */}
              <RuntimeScriptInjector targetDocument={iframeDoc} scripts={runtimeScripts ?? EMPTY_RUNTIME_SCRIPTS} />
            </>,
            iframeDoc.body,
          )}
      </>
    )
  },
)
