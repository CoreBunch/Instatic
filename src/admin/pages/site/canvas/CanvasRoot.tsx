/**
 * CanvasRoot — the top-level canvas component.
 *
 * Responsibilities:
 * - Captures all wheel, drag, and pinch gestures via useCanvas
 * - Manages the CanvasSelectionContext (click → selectNode, hover → hoverNode)
 * - Delegates canvas-level keyboard shortcuts to useCanvasKeyboardShortcuts
 * - Delegates the rename modal to useCanvasRenameDialog + CanvasRenameDialog
 * - Delegates the right-click menu to useCanvasLayerContextMenu + CanvasLayerContextMenu
 * - Renders CanvasTransformLayer inside the gesture-capture area
 * - Renders CanvasNotch (position: absolute, not in transform layer)
 * - Handles double-click on base.visual-component-ref → enters VC canvas mode
 *
 * Performance architecture:
 * - Pan/zoom writes go directly to CanvasTransformLayer's style.transform via ref
 * - No React state is updated during active interaction (60fps pan/zoom)
 * - NodeRenderer components memo'd per node — only affected nodes re-render on edit
 *
 * Accessibility:
 * - tabIndex={0} so the canvas receives keyboard events
 * - aria-label for screen reader orientation
 * - prefers-reduced-motion: CSS transitions are disabled for users who opt out
 */

import { lazy, Suspense, useContext, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react'
import { hasPluginLivePreview, subscribePluginLivePreview } from '@core/plugins/livePreview'
import { useEditorStore, selectActiveCanvasPage, selectPropertiesPanelVisible, selectRightSidebarExpanded } from '@site/store/store'
import { getNodeDisplayName, type Breakpoint, type PageNode } from '@core/page-tree'
import { useMobileViewport } from '@admin/lib/mobileViewport'
import { canReadMedia } from '@admin/access'
import { PhoneImageAction } from './PhoneImageAction'
import { inlineTextEditSpec } from '@site/store/slices/inlineEditSlice'
import { MoreHorizontalSolidIcon } from 'pixel-art-icons/icons/more-horizontal-solid'
import { Button } from '@ui/components/Button'
import { registry } from '@core/module-engine'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import { SpotlightContext } from '@admin/spotlight/spotlightContext'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import { useCanvas } from '@site/hooks/useCanvas'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { CanvasTransformLayer } from './CanvasTransformLayer'
import { CanvasLiveSurface, type PreviewScale } from './CanvasLiveSurface'
import { AgentSnapshotFrame } from './AgentSnapshotFrame'
import { useRuntimeScriptBuild } from './useRuntimeScriptBuild'
import { useCanvasToolbarLayout } from './useCanvasToolbarLayout'
import { useCanvasHistoryShortcuts } from './useCanvasHistoryShortcuts'
import { CanvasNotch } from './CanvasNotch'
import { CanvasModeToggle } from './CanvasModeToggle'
import { panSelectedCanvasNodeIntoView } from './revealSelectedCanvasNode'
import { CanvasContextSelector } from './CanvasContextSelector'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { usePublishEditorPresence } from '@site/collab/awarenessState'
import { CanvasSelectionContext, CanvasViewportActionsContext } from './CanvasContexts'
// Class / user-stylesheet injectors are now mounted per breakpoint frame
// (inside each iframe's document) by `IframeFrameSurface`. CanvasRoot no
// longer injects site CSS into the editor's document — that path was a
// stopgap before the iframe cut-over. See
// `docs/features/canvas-iframe-per-frame.md`.
import { PluginCanvasOverlayLayer } from './PluginCanvasOverlayLayer'
import { CanvasRenameDialog } from './CanvasRenameDialog'
import { useCanvasRenameDialog } from './useCanvasRenameDialog'
import { CanvasLayerContextMenu } from './CanvasLayerContextMenu'
import { useCanvasLayerContextMenu } from './useCanvasLayerContextMenu'
import { useCanvasKeyboardShortcuts } from './useCanvasKeyboardShortcuts'
import { clientPointToEditorDoc } from './canvasDomGeometry'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { useEditorPreference, readEditorSelectPreference } from '@site/preferences/editorPreferences'
import { useAppPairPreview } from './useAppPairPreview'
import { useTemplatePreviewContext } from '@site/hooks/useTemplatePreviewContext'
import styles from './CanvasRoot.module.css'
import { userDisplayLabel } from '@core/users/displayName'

const VisualComponentModeControl = lazy(() =>
  import('./VisualComponentModeControl').then((module) => ({ default: module.default })),
)

const TemplateModeControl = lazy(() =>
  import('./TemplateModeControl').then((module) => ({ default: module.default })),
)

/**
 * Stable empty-breakpoints sentinel — used as the `?? fallback` in the
 * breakpoints selector so that `Object.is(prev, next)` returns `true` when
 * the site is null, preventing useSyncExternalStore from entering an
 * infinite re-render loop.  Never use `?? []` inline in a useEditorStore
 * selector — a new array literal has a new identity on every call.
 */
const EMPTY_BREAKPOINTS: Breakpoint[] = []

interface CanvasRootProps {
  editable?: boolean
}

function phoneContentAction(node: PageNode | undefined, canBrowseImages: boolean) {
  if (!node || node.hidden) return null
  if (node.moduleId === 'base.image' && canBrowseImages && !node.locked && !node.dynamicBindings?.src) return 'image'
  const spec = inlineTextEditSpec(node)
  return spec && typeof node.props[spec.prop] === 'string' ? 'text' : null
}

export function CanvasRoot({ editable = true }: CanvasRootProps) {
  useCanvasHistoryShortcuts(editable)
  const transformLayerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const spotlight = useContext(SpotlightContext)

  // Live co-editing: broadcast this editor's identity + active doc +
  // selection into awareness. Peers render it via PeerPresenceOverlay.
  const currentUser = useCurrentAdminUser()
  usePublishEditorPresence(
    currentUser
      ? {
          id: currentUser.id,
          // Never empty: an admin without a display name would otherwise
          // publish no presence at all (peers saw no cursor, and the
          // "someone else is editing" guards never fired).
          name: userDisplayLabel(currentUser),
          avatarUrl: currentUser.avatarUrl,
          gravatarHash: currentUser.gravatarHash,
        }
      : null,
  )

  // Store subscriptions
  const canvasPage = useEditorStore(selectActiveCanvasPage)
  const breakpoints = useEditorStore((s) => s.site?.breakpoints ?? EMPTY_BREAKPOINTS)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const savedView = useEditorStore((s) => s.canvasView)
  const dockedPreview = useSyncExternalStore(subscribePluginLivePreview, hasPluginLivePreview)
  const [previewScale, setPreviewScale] = useState<PreviewScale>('fit')
  const canvasView = dockedPreview ? 'live' : savedView
  const agentSnapshotCaptureRequest = useEditorStore((s) => s.agentSnapshotCaptureRequest)
  const phone = useMobileViewport()
  const rightSidebarExpanded = useEditorStore(phone ? selectPropertiesPanelVisible : selectRightSidebarExpanded)
  const isLive = canvasView === 'live'
  const runScripts = useEditorStore((s) => s.runScripts)
  // selectedNodeId is needed here for canvas-level keyboard shortcuts (Delete, Ctrl+D).
  // hoveredNodeId is NOT subscribed here — NodeRenderer handles its own hover state
  // via per-node selectors to avoid O(N) re-renders on every hover event (#495).
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const selectNode = useEditorStore((s) => s.selectNode)
  const hoverNode = useEditorStore((s) => s.hoverNode)
  const clearSelection = useEditorStore((s) => s.clearSelection)
  const deleteNode = useEditorStore((s) => s.deleteNode)
  // Multi-select: keyboard shortcuts dispatch the *Nodes batch actions when a
  // multi-selection is active so a single Ctrl+D / Delete / Cmd+C/X/V acts on
  // every selected layer in one undo step.
  const deleteNodes = useEditorStore((s) => s.deleteNodes)
  const duplicateNode = useEditorStore((s) => s.duplicateNode)
  const duplicateNodes = useEditorStore((s) => s.duplicateNodes)
  const renameNode = useEditorStore((s) => s.renameNode)
  const wrapNode = useEditorStore((s) => s.wrapNode)
  const copyNode = useEditorStore((s) => s.copyNode)
  const copyNodes = useEditorStore((s) => s.copyNodes)
  const cutNode = useEditorStore((s) => s.cutNode)
  const cutNodes = useEditorStore((s) => s.cutNodes)
  const pasteNode = useEditorStore((s) => s.pasteNode)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)
  const startInlineEdit = useEditorStore((s) => s.startInlineEdit)
  const setFocusedPanel = useEditorStore((s) => s.setFocusedPanel)
  const setActiveDocument = useEditorStore((s) => s.setActiveDocument)
  const activeDocument = useEditorStore((s) => s.activeDocument)
  const {
    context: pagePreviewContext,
    loading: templatePreviewContextLoading,
  } = useTemplatePreviewContext(canvasPage)
  const { templatePreviewContext, stateControl } = useAppPairPreview(canvasPage, pagePreviewContext)
  const agentSnapshotBreakpoint = agentSnapshotCaptureRequest
    ? breakpoints.find((breakpoint) => breakpoint.id === agentSnapshotCaptureRequest.breakpointId) ?? null
    : null
  // Permission context — gates canvas affordances:
  //   canEditContent → double-click inline text editing
  //   canEditStyle / canEditStructure → properties sidebar
  const permissions = useEditorPermissions()
  const editingText = useEditorStore((s) => s.activeInlineEdit !== null)
  const canShowContentActions = useEditorStore((s) =>
    s.selectedNodeIds.length === 1 && s.propertiesPanel.collapsed &&
    !s.collapsedBreakpointIds.includes(s.activeBreakpointId),
  )
  const endInlineEdit = useEditorStore((s) => s.endInlineEdit)
  const setPropertiesPanel = useEditorStore((s) => s.setPropertiesPanel)
  const phoneContentEnabled = phone && !isLive && editable && permissions.canEditContent
  const canBrowseImages = canReadMedia(currentUser)
  const selectedNode = selectedNodeId ? canvasPage?.nodes[selectedNodeId] : undefined
  const action = phoneContentAction(selectedNode, canBrowseImages)
  const showPhoneContentActions = phoneContentEnabled && canShowContentActions && selectedNodeId &&
    action &&
    breakpoints.some((bp) => bp.id === activeBreakpointId && bp.previewFrame !== false)
  const phoneEditing = phone && editingText
  const showContext = breakpoints.length > 0 && !isLive && !phoneEditing && (phone || rightSidebarExpanded) && (permissions.canEditStyle || permissions.canEditStructure)
  const toolbarLayout = useCanvasToolbarLayout(canvasRef, editable && !phoneEditing, showContext, phone)
  const compactChrome = toolbarLayout !== 'expanded'
  const [layerActionsFor, setLayerActionsFor] = useState<string | null>(null)
  const showLayerActions = layerActionsFor !== null && layerActionsFor === selectedNodeId
  // Auto-dim non-active breakpoints when a layer is selected and the
  // properties panel is open — gated by the `dimInactiveBreakpoints` user
  // preference so designers comparing breakpoints side-by-side can keep
  // them all bright.
  const dimInactiveBreakpointsPref = useEditorPreference('dimInactiveBreakpoints')
  const focusActiveBreakpoint =
    dimInactiveBreakpointsPref && Boolean(selectedNodeId && rightSidebarExpanded)
  const preserveSelectionWhenActivatingBreakpoint = Boolean(selectedNodeId && rightSidebarExpanded)

  // Routes destructive actions through the editor's central confirm dialog.
  // When the `confirmBeforeDelete` preference is off, the commit callback
  // runs synchronously — same behaviour as before this preference existed.
  const confirmDelete = useConfirmDelete()
  const requestDeleteNode = (nodeId: string) => {
    const page = canvasPage
    if (!page) return
    const node = page.nodes[nodeId]
    const definition = node ? registry.get(node.moduleId) : undefined
    const label = node
      ? getNodeDisplayName(node, definition, useEditorStore.getState().site?.visualComponents)
      : 'this layer'
    confirmDelete({
      title: 'Delete layer?',
      description: `${label} and any of its children will be removed. This can be undone with Ctrl/Cmd+Z.`,
      confirmLabel: 'Delete',
      commit: () => {
        deleteNode(nodeId)
        if (nodeId === useEditorStore.getState().selectedNodeId) clearSelection()
      },
    })
  }

  // Canvas gesture hook (pan/zoom). Disabled in preview mode — preview owns
  // its own surface (CanvasLiveSurface) and pan/zoom is meaningless on a
  // single sandboxed iframe. Critically, this also stops wheel events from
  // silently mutating transformRef while in preview, which would otherwise
  // make the design canvas visibly jump on the first interaction after
  // returning from preview.
  const { bind, handleKeyDown: canvasKeyDown, panBy, centerOnBreakpointFrame } = useCanvas({
    canvasRootRef: canvasRef,
    transformLayerRef,
    enabled: !isLive,
  })

  // ─── Focus the chosen viewport frame: loading skeleton → page → switches ───
  // The canvas always mounts at pan (0,0), which shows the left-most (mobile)
  // frame. Pan to horizontally center the chosen viewport so it's actually
  // focused on screen. This runs in three situations, all funnelled through the
  // same effect:
  //
  //  1. While the page data loads, `CanvasTransformLayer` renders skeleton
  //     frames. We center the skeleton for the user's `defaultBreakpoint`
  //     preference — what `activeBreakpointId` WILL become once the site loads
  //     (`applyDefaultBreakpointPreference` in usePersistence). Centering the
  //     skeleton on the same frame means there's no jump when real content
  //     replaces it.
  //  2. Once the page is available, we center the real frame for the resolved
  //     `activeBreakpointId`.
  //  3. On document switch (page ↔ page, entering/leaving a Visual Component),
  //     we re-center so jumping from a long page you'd scrolled down to a
  //     shorter one brings the active frame back into view.
  //
  // The effect keys on `canvasPage.id` (a stable per-document string) rather
  // than the page OBJECT: Mutative hands back a fresh page object on every edit,
  // and depending on the object would re-run this effect — cancelling the
  // in-flight retry before it fires — on every keystroke during load. Keying on
  // the id (null during the skeleton phase) means we run once per document:
  // ordinary edits and clicks inside frames preserve the designer's place.
  // Explicit picker navigation reveals its target separately.
  //
  // We retry on a short timer rather than requestAnimationFrame because the
  // frames mount a few ticks after the effect runs (the per-frame iframes lay
  // out asynchronously), and rAF only fires while the tab is painting — a
  // centering scheduled while the editor is backgrounded would silently never
  // run. setTimeout fires regardless, and reading getBoundingClientRect forces
  // the layout we need synchronously. The cap is a safety valve for a breakpoint
  // that has no preview frame at all.
  const canvasPageId = canvasPage?.id ?? null
  useEffect(() => {
    if (isLive) return

    let timerId: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const MAX_ATTEMPTS = 200 // ~3s at 16ms — frames are ready well within this
    const RETRY_MS = 16
    const tryCenter = () => {
      // Loaded: the resolved active breakpoint. Skeleton (no page yet): the
      // preferred default breakpoint, which is what active WILL resolve to.
      const targetId = canvasPageId
        ? useEditorStore.getState().activeBreakpointId
        : readEditorSelectPreference('defaultBreakpoint')
      if (centerOnBreakpointFrame(targetId) || attempts++ >= MAX_ATTEMPTS) return
      timerId = setTimeout(tryCenter, RETRY_MS)
    }
    tryCenter()
    return () => clearTimeout(timerId)
  }, [canvasPageId, isLive, centerOnBreakpointFrame])

  // ─── Modals & overlays ─────────────────────────────────────────────────────

  const renameDialog = useCanvasRenameDialog(renameNode)
  const contextMenu = useCanvasLayerContextMenu()

  // "Paste HTML here…" — read the clipboard, then open the import modal
  // with the clicked node as the insertion parent.
  const openImportHtmlModal = useEditorStore((s) => s.openImportHtmlModal)
  const handlePasteHtml = async (nodeId: string) => {
    let prefillHtml = ''
    try {
      prefillHtml = await navigator.clipboard.readText()
    } catch (_err) {
      // Clipboard permission denied or API unavailable — open with an empty editor.
    }
    openImportHtmlModal({ parentId: nodeId, prefillHtml })
  }

  // ─── Selection context value ───────────────────────────────────────────────

  const onNodeClick = (nodeId: string, e: React.MouseEvent, breakpointId?: string) => {
    e.stopPropagation()
    if (breakpointId && breakpointId !== activeBreakpointId) {
      setActiveBreakpoint(breakpointId)
      if (preserveSelectionWhenActivatingBreakpoint) {
        setFocusedPanel('canvas')
        return
      }
    }
    // Modifier-aware selection (multi-select): Cmd/Ctrl-click toggles, Shift-
    // click extends a range from the anchor. Plain clicks replace the
    // selection (default mode in `selectNode`).
    const mode = e.shiftKey
      ? 'range'
      : e.metaKey || e.ctrlKey
        ? 'toggle'
        : 'replace'
    const preservePropertiesPanelCollapse = phoneContentEnabled && mode === 'replace' &&
      Boolean(phoneContentAction(selectActiveCanvasPage(useEditorStore.getState())?.nodes[nodeId], canBrowseImages))
    selectNode(nodeId, mode, { propertiesPanel: preservePropertiesPanelCollapse ? 'preserve' : 'open' })
    setFocusedPanel('canvas')
  }

  const onNodeHover = (nodeId: string | null, breakpointId?: string) => {
    hoverNode(nodeId, breakpointId)
  }

  const onNodeContextMenu = (nodeId: string, e: React.MouseEvent, breakpointId?: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (!editable) return
    if (breakpointId && breakpointId !== activeBreakpointId) {
      setActiveBreakpoint(breakpointId)
    }
    // If the right-clicked node is part of an existing multi-selection,
    // KEEP the selection (the menu acts on the whole set). Otherwise replace
    // the selection with just this node — matches Figma / VS Code behavior.
    const currentIds = useEditorStore.getState().selectedNodeIds
    if (!currentIds.includes(nodeId)) {
      selectNode(nodeId)
    }
    setFocusedPanel('canvas')
    // The right-click event originates inside the per-breakpoint iframe, so
    // `e.clientX` / `e.clientY` are relative to the iframe's own viewport.
    // The context menu is portaled into the editor's `document.body` with
    // `position: fixed` — it needs editor-document coordinates, which
    // `clientPointToEditorDoc` produces by adding the iframe's outer rect
    // (scaled by the canvas zoom).
    const point = clientPointToEditorDoc(e.nativeEvent ?? e)
    contextMenu.open({ x: point.x, y: point.y, nodeId })
  }

  /**
   * Double-click on a canvas node → start an inline text-edit session when
   * the node's module declares `inlineTextEdit` (base.text, base.button,
   * childless base.link — `startInlineEdit` resolves the contract and
   * no-ops for everything else, so other modules keep the old no-op).
   *
   * Design-canvas only: the editing element lives inside a breakpoint iframe,
   * so a live-mode double-click must not open a session. Entering VC canvas
   * mode on double-click stays removed — VC entry works from the Site panel
   * and Spotlight (see `docs/features/canvas-iframe-per-frame.md`).
   */
  const onNodeDoubleClick = (nodeId: string, e: React.MouseEvent, breakpointId?: string) => {
    e.stopPropagation()
    if (isLive || !editable || !permissions.canEditContent) return
    startInlineEdit(nodeId, breakpointId ?? activeBreakpointId)
  }

  // Context carries only stable callbacks — selectedNodeId/hoveredNodeId are
  // intentionally excluded (Perf fix — Contribution #495). Each NodeRenderer
  // subscribes to its own boolean directly, so only the 2 affected nodes
  // re-render per selection/hover event rather than the entire canvas tree.
  const selectionContextValue = { onNodeClick, onNodeHover, onNodeContextMenu, onNodeDoubleClick }

  const viewportActionsContextValue = { canvasRootRef: canvasRef, panBy }

  // ─── Canvas-level keyboard shortcuts ──────────────────────────────────────
  // Match predicates come from the keybindings registry — single source of truth.

  const handleKeyDown = useCanvasKeyboardShortcuts({
    canvasKeyDown,
    selectedNodeId,
    editable,
    activeDocument,
    setActiveDocument,
    clearSelection,
    requestDeleteNode,
    deleteNodes,
    duplicateNode,
    duplicateNodes,
    copyNode,
    copyNodes,
    cutNode,
    cutNodes,
    pasteNode,
    runShortcut: spotlight?.runShortcut,
  })

  const requestDeleteSelectionFromShortcut = useEffectEvent((
    currentSelectedNodeId: string,
    currentIds: readonly string[],
  ) => {
    if (currentIds.length > 1) {
      deleteNodes([...currentIds])
      clearSelection()
    } else {
      requestDeleteNode(currentSelectedNodeId)
    }
  })

  useEffect(() => {
    if (isLive || !editable) return
    const deleteBinding = getKeybindingForCommand('layers.delete')
    if (!deleteBinding) return

    const isCanvasEvent = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof Element && canvasRef.current?.contains(target)) return true
      const activeElement = document.activeElement
      return activeElement instanceof Element && canvasRef.current?.contains(activeElement)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (useEditorStore.getState().activeInlineEdit) return
      if (!deleteBinding.match(event)) return
      if (!isCanvasEvent(event)) return

      const state = useEditorStore.getState()
      const currentIds = state.selectedNodeIds
      const currentSelectedNodeId = state.selectedNodeId
      if (!currentSelectedNodeId) return

      event.preventDefault()
      event.stopPropagation()

      requestDeleteSelectionFromShortcut(currentSelectedNodeId, currentIds)
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [editable, isLive])

  // ─── Canvas background click → deselect ───────────────────────────────────

  const handleCanvasClick = () => {
    contextMenu.close()
    clearSelection()
  }

  // Resolve the active breakpoint object for the live surface (which wants the
  // full Breakpoint, not just the id, to read .width).
  const activeBreakpoint = breakpoints.find((bp) => bp.id === activeBreakpointId) ?? breakpoints[0] ?? null

  // Runtime scripts (opt-in "Run scripts" toggle). Built once here and shared
  // by every editable frame — the design canvas's per-breakpoint frames AND
  // the live surface's single frame — so the same bundle runs everywhere
  // without rebuilding per frame. Idle (no build) while the toggle is off.
  const scriptBuild = useRuntimeScriptBuild({
    page: canvasPage,
    breakpointId: activeBreakpointId,
    templateContext: templatePreviewContext,
    enabled: runScripts,
  })
  const runtimeScripts = scriptBuild.scripts

  // Live mode skips canvas-level pan/zoom gestures and shortcuts: the single
  // real-size frame scrolls natively. Spreading {} keeps the outer div's prop
  // shape stable when toggling.
  const gestureBindings = isLive ? {} : bind()
  const onCanvasKeyDown = isLive ? undefined : handleKeyDown
  const onCanvasClick = isLive ? undefined : handleCanvasClick

  return (
    <CanvasViewportActionsContext.Provider value={viewportActionsContextValue}>
      <CanvasSelectionContext.Provider value={selectionContextValue}>
        <div
          ref={canvasRef}
          role="region"
          aria-label="Canvas — infinite editing surface"
          tabIndex={0}
          data-testid="canvas-root"
          data-instatic-canvas-root="true"
          data-toolbar-layout={toolbarLayout}
          data-canvas-state={canvasPage ? 'canvas-ready' : 'canvas-empty'}
          data-canvas-view={canvasView}
          data-hide-layer-actions={phoneEditing || (showPhoneContentActions && !showLayerActions) || undefined}
          data-vc-mode={activeDocument?.kind === 'visualComponent' ? 'true' : undefined}
          onKeyDown={onCanvasKeyDown}
          onClick={onCanvasClick}
          onFocus={() => setFocusedPanel('canvas')}
          className={styles.canvas}
          // Spread gesture handlers from useGesture (wheel, drag, pinch).
          // Empty in preview mode — see gestureBindings above.
          {...gestureBindings}
        >
          {/* CSS for prefers-reduced-motion — no transitions for accessibility */}
          <style>{`
          @media (prefers-reduced-motion: reduce) {
            [data-testid="canvas-transform-layer"] {
              transition: none !important;
            }
          }
        `}</style>

          {/* Site CSS (class registry + user stylesheets) lives inside each
            breakpoint iframe now — mounted per-frame by IframeFrameSurface
            so the canvas sees the same cascade the published page sees. */}

          {!phoneEditing && (
            <div className={styles.canvasToolbar}>
              <CanvasModeToggle
                scaleControl={dockedPreview ? { value: previewScale, onChange: setPreviewScale } : undefined}
                peek={isLive && !dockedPreview}
                scriptStatus={scriptBuild.status}
                onRefreshScripts={scriptBuild.refresh}
              />
              {editable && !dockedPreview && (
                <CanvasNotch
                  peek={isLive}
                  compact={compactChrome}
                  floatingControl={
                    stateControl ?? (activeDocument?.kind === 'visualComponent' ? (
                      <Suspense fallback={null}>
                        <VisualComponentModeControl />
                      </Suspense>
                    ) : canvasPage?.template?.enabled ? (
                      <Suspense fallback={null}>
                        <TemplateModeControl />
                      </Suspense>
                    ) : null)
                  }
                />
              )}
            </div>
          )}

          {(phoneEditing || showPhoneContentActions) && (
            <div
              className={styles.phoneContentActions}
              data-editing={phoneEditing}
              role="group"
              aria-label={action === 'image' ? 'Image editing' : 'Text editing'}
              onClick={(event) => event.stopPropagation()}
            >
              {phoneEditing ? (
                <Button
                  variant="primary"
                  size="lg"
                  // Keep the inline editor focused until click. Canceling pointerdown also suppresses a WebKit touch click.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    endInlineEdit()
                    clearSelection()
                    hoverNode(null)
                    canvasRef.current?.focus({ preventScroll: true })
                  }}
                >
                  Done
                </Button>
              ) : selectedNodeId && (
                <>
                  {action === 'image' && selectedNode ? (
                    <PhoneImageAction key={selectedNode.id} node={selectedNode} />
                  ) : (
                    <Button variant="primary" size="md" onClick={() => {
                      setLayerActionsFor(null)
                      startInlineEdit(selectedNodeId, activeBreakpointId)
                    }}>
                      Edit text
                    </Button>
                  )}
                  <Button variant="ghost" size="md" onClick={() => setPropertiesPanel({ collapsed: false })}>
                    Properties
                  </Button>
                  {permissions.canEditStructure && (
                    <Button
                      variant="ghost"
                      size="md"
                      iconOnly
                      aria-label="Layer actions"
                      aria-expanded={showLayerActions}
                      onClick={() => setLayerActionsFor(showLayerActions ? null : selectedNodeId)}
                    >
                      <MoreHorizontalSolidIcon size={14} aria-hidden="true" />
                    </Button>
                  )}
                </>
              )}
            </div>
          )}

          {/* The editing-context switcher targets per-context style overrides
              (viewports + custom conditions), so it's only meaningful for
              callers who can edit style or structure. Content-only Clients and
              pure Viewers get the same plain frames without this affordance. */}
          {showContext && (
            <CanvasContextSelector
              phone={phone}
              compact={compactChrome}
              onPickBreakpoint={(id) => {
                setActiveBreakpoint(id)
                if (!selectedNodeId || !panSelectedCanvasNodeIntoView(selectedNodeId)) {
                  centerOnBreakpointFrame(id)
                }
              }}
            />
          )}

          {/*
          A buggy module render must not blank the toolbar / DOM panel /
          properties panel that share the editor shell. Resetting on the
          active page id means switching pages naturally clears stuck
          errors — the user navigates away from a broken module preview
          rather than getting "stuck" on the failure screen.
        */}
          <ErrorBoundary
            location="canvas"
            resetKeys={[canvasPage?.id ?? null, activeDocument?.kind ?? null, canvasView]}
          >
            {isLive ? (
              <CanvasLiveSurface
                previewScale={dockedPreview ? previewScale : undefined}
                page={canvasPage}
                activeBreakpoint={activeBreakpoint}
                templateContext={templatePreviewContext}
                runtimeScripts={runtimeScripts}
              />
            ) : (
              <CanvasTransformLayer
                ref={transformLayerRef}
                page={canvasPage}
                breakpoints={breakpoints}
                activeBreakpointId={activeBreakpointId}
                dimInactiveBreakpoints={focusActiveBreakpoint}
                activationHintEnabled={preserveSelectionWhenActivatingBreakpoint}
                onBreakpointActivate={setActiveBreakpoint}
                templateContext={templatePreviewContext}
                runtimeScripts={runtimeScripts}
              />
            )}
          </ErrorBoundary>

          {/* Live surfaces render only overlays that opt in. */}
          {editable && <PluginCanvasOverlayLayer live={isLive} />}

          {!isLive && editable && contextMenu.position && (
            <CanvasLayerContextMenu
              position={contextMenu.position}
              onClose={contextMenu.close}
              actions={{
                requestDeleteNode,
                duplicateNode,
                openRenameDialog: renameDialog.open,
                wrapNode,
                copyNode,
                cutNode,
                pasteNode,
                pasteHtml: handlePasteHtml,
              }}
            />
          )}

          {!isLive && editable && renameDialog.state && (
            <CanvasRenameDialog
              state={renameDialog.state}
              onChange={renameDialog.replace}
              onCommit={renameDialog.commit}
              onClose={renameDialog.close}
            />
          )}

          {agentSnapshotCaptureRequest && canvasPage && agentSnapshotBreakpoint ? (
            <AgentSnapshotFrame
              key={agentSnapshotCaptureRequest.requestId}
              requestId={agentSnapshotCaptureRequest.requestId}
              page={canvasPage}
              breakpoint={agentSnapshotBreakpoint}
              templateContext={templatePreviewContext}
              templateContextLoading={templatePreviewContextLoading}
            />
          ) : null}
        </div>
      </CanvasSelectionContext.Provider>
    </CanvasViewportActionsContext.Provider>
  )
}
