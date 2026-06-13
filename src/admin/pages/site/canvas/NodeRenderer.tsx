/**
 * NodeRenderer — renders a single PageNode in the editor canvas.
 *
 * Performance notes (Contribution #312 + #495):
 * ─────────────────────────────────────────────
 * - memo() prevents re-renders when unrelated nodes change.
 * - Per-node Zustand selector: subscribes ONLY to the specific node's data.
 *   Editing node A never re-renders NodeRenderer for node B.
 * - Selection/hover handled via CanvasSelectionContext (no DOM event bubbling).
 * - selectedNodeId / hoveredNodeId are NOT in context (Perf fix #495):
 *   Each NodeRenderer subscribes directly to its own boolean — only the 2
 *   affected nodes re-render per selection/hover event (O(2) not O(N)).
 * - Zustand re-runs EVERY subscriber's selector on EVERY store set, so the
 *   per-node selectors below must be O(1)-ish per sweep: the active-page
 *   resolution is single-slot memoized in `selectActivePage`, the
 *   form-preview helpers cache their parent index per tree identity
 *   (`canvasFormPreview.ts`), and `getCanvasNodeClassIds` passes the node's
 *   own array through untouched when no preview applies — selector outputs
 *   stay referentially stable for unchanged data.
 */

import { memo, use, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { InlineEditBinding } from '@core/module-engine'
import { readInlineEditableText, seedInlineEditableContent } from '@modules/base/shared/inlineText'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { resolveProps } from '@core/page-tree'
import { registry } from '@core/module-engine'
import type { NodeWrapperProps as NodeWrapperPropsType } from '@core/module-engine'
import { resolveDynamicProps, effectiveNodeBindings, type TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import type { PageNode } from '@core/page-tree'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import { ModuleSandboxFrame } from './ModuleSandboxFrame'
import { CanvasBreakpointContext, CanvasSelectionContext, CanvasTemplateContext } from './CanvasContexts'
import {
  addEditorFormPreviewProps,
  resolveEditorFormPreviewState,
  resolveEditorFormPreviewSuccessMessage,
} from './canvasFormPreview'
import { bagToReactStyle } from '@core/publisher'
import { getCanvasNodeClassIds, getCanvasNodeClassName } from './canvasNodeClassName'
import { findEnclosingComponentRef, type AnnotatedPageNode } from './canvasSelectionUtils'
import { useLoopPreviewItems } from './useLoopPreviewItems'
import styles from './NodeRenderer.module.css'

// ---------------------------------------------------------------------------
// NodeRenderer
// ---------------------------------------------------------------------------

interface NodeRendererProps {
  nodeId: string
}

// React Compiler exception #2: memo() re-render bailout on a hot, recursive
// per-node canvas renderer (O(N) critical path) — kept intentionally.
export const NodeRenderer = memo(function NodeRenderer({ nodeId }: NodeRendererProps) {
  // Per-node subscription — editing this node's props only re-renders THIS component.
  // Uses selectActiveCanvasPage (Task #438) so VC canvas mode works alongside page mode.
  const node = useEditorStore((s) => selectActiveCanvasPage(s)?.nodes[nodeId] ?? null)
  const breakpointId = use(CanvasBreakpointContext)
  const templateContext = use(CanvasTemplateContext)

  // Per-node selection/hover subscriptions (Perf fix — Contribution #495).
  // Only the 2 nodes whose boolean flips will re-render on any selection/hover
  // event. Context carries only stable callbacks — no context-driven re-renders.
  //
  // Multi-select: this checks `selectedNodeIds.includes(nodeId)` so every node
  // in a multi-selection shows the selection ring. The selector still resolves
  // to a boolean, so per-node memoization isn't disturbed — only rows whose
  // `includes(nodeId)` result flips will re-render.
  const isSelected = useEditorStore((s) => s.selectedNodeIds.includes(nodeId))
  const isHovered = useEditorStore(
    (s) =>
      s.hoveredNodeId === nodeId &&
      (!s.hoveredBreakpointId || s.hoveredBreakpointId === breakpointId),
  )
  // Inline text edit session — true only in the SESSION'S frame. This frame's
  // node becomes the contentEditable surface; every OTHER breakpoint frame
  // keeps previewing the live-updating text normally.
  const isInlineEditing = useEditorStore(
    (s) =>
      s.activeInlineEdit !== null &&
      s.activeInlineEdit.nodeId === nodeId &&
      s.activeInlineEdit.breakpointId === breakpointId,
  )
  // Session values, read as primitives so per-node memoization stays clean.
  // Both are constant for the whole session (initialValue seeds the frozen
  // content; multiline decides Enter's behaviour).
  const inlineEditInitialValue = useEditorStore((s) =>
    s.activeInlineEdit?.nodeId === nodeId && s.activeInlineEdit.breakpointId === breakpointId
      ? s.activeInlineEdit.initialValue
      : null,
  )
  const inlineEditMultiline = useEditorStore((s) =>
    s.activeInlineEdit?.nodeId === nodeId && s.activeInlineEdit.breakpointId === breakpointId
      ? s.activeInlineEdit.multiline
      : false,
  )
  const applyInlineEditValue = useEditorStore((s) => s.applyInlineEditValue)
  const endInlineEdit = useEditorStore((s) => s.endInlineEdit)
  const cancelInlineEdit = useEditorStore((s) => s.cancelInlineEdit)
  const editableRef = useRef<HTMLElement | null>(null)
  const previewClassAssignment = useEditorStore(
    (s) => s.previewClassAssignment?.nodeId === nodeId ? s.previewClassAssignment : null,
  )
  const editorFormPreviewState = useEditorStore((s) => resolveEditorFormPreviewState(s, nodeId))
  const editorFormPreviewSuccessMessage = useEditorStore((s) => resolveEditorFormPreviewSuccessMessage(s, nodeId))
  const mcClassName = useEditorStore((s) => {
    const canvasNode = selectActiveCanvasPage(s)?.nodes[nodeId]
    const preview = s.previewClassAssignment?.nodeId === nodeId ? s.previewClassAssignment : null
    return getCanvasNodeClassName(canvasNode?.classIds, preview, nodeId, s.site?.styleRules)
  })
  const { onNodeClick, onNodeHover, onNodeContextMenu, onNodeDoubleClick } = use(CanvasSelectionContext)

  const handleNodeClick = (clickedNodeId: string, e: React.MouseEvent) => {
    // B3 — VC lock-down: redirect clicks inside inlined VC bodies to the ref node.
    // Imperative store access is correct here (event handler, not render path).
    const state = useEditorStore.getState()
    if (state.activeDocument?.kind !== 'visualComponent') {
      const page = selectActiveCanvasPage(state)
      if (page) {
        const enclosing = findEnclosingComponentRef(
          page.nodes as Record<string, AnnotatedPageNode>,
          clickedNodeId,
        )
        if (enclosing !== null && !enclosing.isInsideSlotContent) {
          // Clicked inside a VC body (not slot content) — route to the ref.
          onNodeClick(enclosing.refId, e, breakpointId)
          return
        }
      }
    }
    onNodeClick(clickedNodeId, e, breakpointId)
  }

  const handleNodeContextMenu = (clickedNodeId: string, e: React.MouseEvent) => {
    onNodeContextMenu(clickedNodeId, e, breakpointId)
  }

  const handleNodeHover = (hoveredNodeId: string | null) => {
    if (hoveredNodeId !== null) {
      // B3 — VC lock-down: clamp hover ring to the ref node for VC body nodes.
      const state = useEditorStore.getState()
      if (state.activeDocument?.kind !== 'visualComponent') {
        const page = selectActiveCanvasPage(state)
        if (page) {
          const enclosing = findEnclosingComponentRef(
            page.nodes as Record<string, AnnotatedPageNode>,
            hoveredNodeId,
          )
          if (enclosing !== null && !enclosing.isInsideSlotContent) {
            onNodeHover(enclosing.refId, breakpointId)
            return
          }
        }
      }
    }
    onNodeHover(hoveredNodeId, breakpointId)
  }

  // Subscribe to module registry changes so plugin module packs that activate
  // after the canvas mounted trigger a re-render — otherwise the canvas would
  // freeze on `Unknown module` even after the registry receives the module.
  useSyncExternalStore(
    registry.subscribe.bind(registry),
    registry.generation.bind(registry),
    registry.generation.bind(registry),
  )

  // On session start, seed the editable element's content imperatively (React
  // does NOT own it — see inlineEditableElementProps), then focus and drop the
  // caret at the end. Layout effect → runs before paint, so the editor is live
  // on the first frame. The element lives in the breakpoint iframe
  // (same-origin); focusing it focuses the iframe in the parent — no
  // cross-frame negotiation needed. Deps are constant for the whole session, so
  // this runs once per session (never mid-edit, which would wipe the edits).
  // Trade-off: a programmatic mutation that swaps the node's element mid-session
  // (e.g. an RPC changing base.text's `tag`) remounts a fresh, unseeded element
  // and is not re-seeded. Unreachable from the UI — interacting with the
  // Properties panel blurs the editor, which ends the session first.
  useLayoutEffect(() => {
    if (!isInlineEditing) return
    const el = editableRef.current
    if (!el) return
    seedInlineEditableContent(el, inlineEditInitialValue ?? '')
    el.focus()
    const doc = el.ownerDocument
    const sel = doc.defaultView?.getSelection()
    if (!sel) return
    const range = doc.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  }, [isInlineEditing, inlineEditInitialValue])

  if (!node) return null
  if (node.hidden) return null

  const definition = registry.get(node.moduleId)
  if (!definition) {
    return (
      <div
        className={styles.unknownModule}
        data-instatic-unknown-module=""
        title={`Unknown module: ${node.moduleId}`}
      >
        <WarningDiamondSolidIcon size={14} /> Unknown module: {node.moduleId}
      </div>
    )
  }

  // Render children recursively. For `base.loop` nodes, delegate to a
  // dedicated component (`LoopIterationsPreview`) that uses hooks to fetch
  // real iteration data via the CMS API and round-robins variants across
  // iterations. Each iteration pushes a real LoopItem onto the entry stack
  // via a nested CanvasTemplateContext.Provider so dynamic bindings inside
  // the loop body resolve against the iteration item — same semantics as
  // the publisher's renderLoop().
  const children =
    node.moduleId === 'base.loop' && node.children.length > 0 ? (
      <LoopIterationsPreview node={node} baseTemplateContext={templateContext} />
    ) : (
      node.children.map((childId) => <NodeRenderer key={childId} nodeId={childId} />)
    )

  const ComponentType = definition.component
  const shouldRenderSandbox = Boolean(definition.editorRuntime?.sandbox && !definition.trusted)
  // Pass the module schema so resolveProps drops breakpoint overrides for
  // non-responsive (content) keys — text/tag/src etc. must look identical
  // across every breakpoint frame, since published HTML is one document.
  const effectiveProps = addEditorFormPreviewProps(
    node.moduleId,
    resolveDynamicProps(
    resolveProps(node, breakpointId, definition.schema),
    effectiveNodeBindings(node),
    templateContext,
    ),
    editorFormPreviewState,
    editorFormPreviewSuccessMessage,
  )

  // Build className from classIds using the user-facing class names.
  const effectiveClassIds = getCanvasNodeClassIds(node.classIds, previewClassAssignment, nodeId)

  // Editor attributes + event handlers the module spreads onto its root
  // element. Previously this was a wrapping `<div class="nodeWrapper">`
  // around every node — that wrapper broke CSS combinators (`body > nav`,
  // `:nth-child()`, etc.) because it sat between every authored element.
  // Moving the bag onto the module's own root removes the wrapper entirely
  // and the canvas DOM matches the published DOM exactly.
  // Per-node inline styles → React style object on the root element, matching
  // the published `style="…"` attribute (sanitised to the same gate).
  const inlineStyle = bagToReactStyle(node.inlineStyles)

  const nodeWrapperProps: NodeWrapperPropsType = {
    'data-node-id': nodeId,
    'data-module-id': node.moduleId,
    tabIndex: 0,
    ...(isSelected ? { 'data-canvas-selected': 'true' as const } : {}),
    ...(inlineStyle ? { style: inlineStyle } : {}),
    ...(isHovered && !isSelected ? { 'data-hovered': 'true' as const } : {}),
    onPointerDownCapture: (e) => {
      if (!shouldSuppressAuthoredFormControlEvent(e.target, e.currentTarget)) return
      e.preventDefault()
      e.stopPropagation()
      latestSuppressedPointerTarget = e.currentTarget
      handleNodeClick(nodeId, e as unknown as React.MouseEvent)
    },
    onMouseDownCapture: (e) => {
      if (!shouldSuppressAuthoredFormControlEvent(e.target, e.currentTarget)) return
      e.preventDefault()
      e.stopPropagation()
      if (latestSuppressedPointerTarget === e.currentTarget) {
        latestSuppressedPointerTarget = null
        return
      }
      handleNodeClick(nodeId, e as unknown as React.MouseEvent)
    },
    onFocusCapture: (e) => {
      if (!shouldSuppressAuthoredFormControlEvent(e.target, e.currentTarget)) return
      if (isFocusableElement(e.target)) e.target.blur()
    },
    onClickCapture: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) return
      e.preventDefault()
      e.stopPropagation()
      handleNodeClick(nodeId, e as unknown as React.MouseEvent)
    },
    onClick: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) {
        e.stopPropagation()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      handleNodeClick(nodeId, e as unknown as React.MouseEvent)
    },
    onDoubleClickCapture: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) return
      e.preventDefault()
      e.stopPropagation()
      onNodeDoubleClick(nodeId, e as unknown as React.MouseEvent, breakpointId)
    },
    onDoubleClick: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) {
        e.stopPropagation()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      onNodeDoubleClick(nodeId, e as unknown as React.MouseEvent, breakpointId)
    },
    onContextMenuCapture: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) return
      e.preventDefault()
      e.stopPropagation()
      handleNodeContextMenu(nodeId, e as unknown as React.MouseEvent)
    },
    onContextMenu: (e) => {
      if (!isClosestCanvasNodeTarget(e.target, e.currentTarget)) return
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) {
        e.stopPropagation()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      handleNodeContextMenu(nodeId, e as unknown as React.MouseEvent)
    },
    onKeyDown: (e) => {
      if (isCanvasEditorControlTarget(e.target, e.currentTarget)) {
        e.stopPropagation()
        return
      }
      // Editable-target guard: the canvas treats Enter / Space as
      // "click this node" so a focused-but-not-clicked node can be
      // activated from the keyboard. When the keystroke originates from
      // an `<input>` / `<textarea>` / `[contenteditable]` (e.g. a form
      // field the author placed inside their page), we leave the
      // keystroke alone so it can land in the field.
      if (isEditableTextTarget(e.target)) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        handleNodeClick(nodeId, e as unknown as React.MouseEvent)
      }
    },
    onMouseEnter: () => handleNodeHover(nodeId),
    onMouseLeave: () => handleNodeHover(null),
  }

  // Inline editing: this node's element becomes the contentEditable surface.
  // The binding seeds it from the frozen initial value and reads edits back
  // out; the live commit flows through `applyInlineEditValue` (coalesced into
  // one undo entry). While editing we strip the selection/click/dblclick
  // handlers from the element so native caret placement and text selection
  // work — only the data attributes (needed by the selection-ring overlay)
  // and inline style remain.
  const inlineEditBinding: InlineEditBinding | undefined = isInlineEditing
    ? {
        ref: editableRef,
        onInput: (e) => applyInlineEditValue(readInlineEditableText(e.currentTarget as HTMLElement)),
        onKeyDown: (e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            cancelInlineEdit()
            return
          }
          if (e.key === 'Enter') {
            // Cmd/Ctrl+Enter always commits. Plain Enter commits for
            // single-line modules; for multiline it falls through so the
            // browser inserts the hard break the author wants.
            if (e.metaKey || e.ctrlKey || !inlineEditMultiline) {
              e.preventDefault()
              endInlineEdit()
            }
          }
        },
        onBlur: () => endInlineEdit(),
      }
    : undefined

  const effectiveWrapperProps: NodeWrapperPropsType = isInlineEditing
    ? {
        'data-node-id': nodeId,
        'data-module-id': node.moduleId,
        ...(isSelected ? { 'data-canvas-selected': 'true' as const } : {}),
        ...(inlineStyle ? { style: inlineStyle } : {}),
      }
    : nodeWrapperProps

  // Per-module isolation: a buggy module render must not collapse the
  // entire canvas. The boundary scope is per-module render path; the rest
  // of the page tree keeps working. resetKeys on the moduleId means an
  // editor swap to a different module clears any stuck error.
  // silentToast: the canvas-level boundary already toasts; 100 nodes with
  // one bad module would otherwise produce 100 identical toasts per render.
  return (
    <ErrorBoundary
      location="node-renderer"
      resetKeys={[node.moduleId, nodeId]}
      silentToast
    >
      {shouldRenderSandbox ? (
        <ModuleSandboxFrame
          moduleDefinition={definition}
          props={effectiveProps}
          nodeId={nodeId}
          isSelected={isSelected}
          mcClassName={mcClassName}
          classIds={effectiveClassIds}
        />
      ) : (
        <ComponentType
          props={effectiveProps as never}
          nodeId={nodeId}
          isSelected={isSelected}
          mcClassName={mcClassName}
          nodeWrapperProps={effectiveWrapperProps}
          inlineEdit={inlineEditBinding}
        >
          {isInlineEditing ? undefined : children}
        </ComponentType>
      )}
    </ErrorBoundary>
  )
})

// ---------------------------------------------------------------------------
// Loop iteration preview
// ---------------------------------------------------------------------------

interface LoopIterationsPreviewProps {
  node: PageNode
  baseTemplateContext?: TemplateRenderDataContext
}

/**
 * Render a `base.loop` node's children once per real iteration item.
 *
 * Mirrors the publisher's `renderLoop()` in `src/core/publisher/render.ts`:
 *   - Round-robin children when N variants × M items.
 *   - Augmented `templateContext` per iteration via Context.Provider, so
 *     dynamic bindings inside the loop body resolve to the iteration's
 *     `currentEntry`.
 *
 * Iteration data comes from `useLoopPreviewItems`, which dispatches per
 * source: built-in sources (`content.entries`, `site.media`) fetch real
 * data via the CMS API; in-memory sources (`site.pages`) read directly
 * from the store; plugin sources fall back to their `preview()` method.
 *
 * Empty result (source not picked yet, no rows, fetch in flight) renders
 * nothing — same as the publisher's empty-loop behaviour. Once data
 * arrives the component re-renders with real iterations.
 */
function LoopIterationsPreview({ node, baseTemplateContext }: LoopIterationsPreviewProps) {
  const items = useLoopPreviewItems(node)
  if (items.length === 0) return null

  const baseStack = baseTemplateContext?.entryStack ?? []
  return (
    <>
      {items.map((item, i) => {
        const variantId = node.children[i % node.children.length]
        // Preserve the parent's `page` / `site` / `viewer` / `route`
        // frames so bindings against those sources keep resolving
        // inside loop iterations. Only the entry stack changes per
        // iteration — push the iteration item on top.
        const augmentedContext: TemplateRenderDataContext = {
          ...baseTemplateContext,
          entryStack: [...baseStack, item],
        }
        return (
          <CanvasTemplateContext.Provider
            key={`${variantId}-${i}-${item.id}`}
            value={augmentedContext}
          >
            <NodeRenderer nodeId={variantId} />
          </CanvasTemplateContext.Provider>
        )
      })}
    </>
  )
}

// NodeWrapper as a wrapping `<div>` is gone. The editor attributes and
// handlers it used to host are now in `nodeWrapperProps` (built up above and
// passed into each module's component). The publisher emits the same root
// element the canvas does, so the canvas DOM matches the published DOM 1:1.

const CANVAS_EDITOR_CONTROL_SELECTOR = '[data-canvas-interactive="true"]'
const CANVAS_NODE_SELECTOR = '[data-node-id]'
const CANVAS_FORM_CONTROL_SELECTOR = 'input, textarea, select, button, option, optgroup'
let latestSuppressedPointerTarget: EventTarget | null = null

/**
 * Duck-type "is this an Element?" check that works across documents. The
 * canvas now renders each breakpoint frame inside an iframe, and click
 * targets inside the iframe are instances of the iframe's own `Element`
 * constructor — `target instanceof Element` (where `Element` resolves to
 * the EDITOR window's class) returns false for them. Using a structural
 * check (`closest` callable) sidesteps that, since both the editor's and
 * the iframe's Elements expose the same DOM API.
 */
function isElementLike(value: EventTarget | null): value is Element {
  return value != null && typeof (value as { closest?: unknown }).closest === 'function'
}

/**
 * True when the event target sits inside a form input or contentEditable —
 * i.e. the user is actively typing into something. Canvas keyboard
 * shortcuts (Enter / Space / Delete / Ctrl+D / ...) must NOT hijack those
 * keystrokes because that would defeat the author-rendered form fields
 * inside the preview. `INPUT` / `TEXTAREA` cover normal form fields;
 * `closest('[contenteditable]')` covers any author-rendered rich-text
 * surfaces (none ship with the first-party module pack today, but third-
 * party modules may use them).
 */
function isEditableTextTarget(target: EventTarget | null): boolean {
  if (!isElementLike(target)) return false
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return true
  return target.closest('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]') !== null
}

function isClosestCanvasNodeTarget(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  if (!isElementLike(target) || !isElementLike(currentTarget)) {
    return true
  }

  const closestNode = target.closest(CANVAS_NODE_SELECTOR)
  return closestNode === currentTarget
}

function isCanvasEditorControlTarget(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  if (!isElementLike(target) || !isElementLike(currentTarget)) {
    return false
  }

  const interactive = target.closest(CANVAS_EDITOR_CONTROL_SELECTOR)
  return Boolean(interactive && currentTarget.contains(interactive))
}

function shouldSuppressAuthoredFormControlEvent(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  if (!isClosestCanvasNodeTarget(target, currentTarget)) return false
  if (isCanvasEditorControlTarget(target, currentTarget)) return false
  return isAuthoredFormControlTarget(target, currentTarget)
}

function isAuthoredFormControlTarget(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  if (!isElementLike(target) || !isElementLike(currentTarget)) return false
  const control = target.closest(CANVAS_FORM_CONTROL_SELECTOR)
  return Boolean(control && currentTarget.contains(control))
}

function isFocusableElement(target: EventTarget | null): target is HTMLElement {
  return isElementLike(target) && typeof (target as HTMLElement).blur === 'function'
}
