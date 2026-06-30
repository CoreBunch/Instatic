/**
 * DomPanel — the Layers tab of the consolidated `ExplorerPanel`.
 *
 * Renders the full node tree of the active page. It is always mounted as a tab
 * body inside `ExplorerPanel`, which owns the panel shell (header + segmented
 * tabs + close button) and controls visibility. DomPanel therefore has no
 * chrome of its own — no draggable header, no collapse toggle, no width
 * persistence; it fills the sidebar slot the Explorer panel gives it.
 *
 * Guideline #357 (Compact UI Density):
 * - Row height: 28px (WCAG touch target NOT required for editor chrome)
 * - Font: 12px, icons: 14px
 *
 * Guideline #318 (Phase 3 Perf):
 * - Per-node Zustand selectors: only affected rows re-render on selection/hover
 * - DnD drag position tracked via refs; store updated once on dragEnd
 * - ExpansionStore is an external observable in DomTreeContext (UI-only) — never in siteSlice
 *
 * Guideline #321 (Phase 3 Architecture):
 * - DndContext wraps the whole tree; SortableContexts are per-parent group
 * - Search: flat filtered list bypasses tree rendering when query is active
 * - Ancestor auto-expand + scroll-to-selected on canvas selection change
 *
 * Accessibility:
 * - role="tree" on tree container
 * - data-panel attribute for event propagation guard (Guideline #192)
 * - data-testid="dom-panel" and "dom-panel-ready" for Playwright (Guideline #221)
 */
import { useEffect, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { createPortal } from 'react-dom'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { flattenSubtree } from '@core/page-tree'
import { getAncestorIds } from '@site/hooks/useTreeWalkOrder'
import { registry } from '@core/module-engine'
import {
  getNodeDisplayName,
  getNodeHtmlTag,
  getNodeClassNames,
} from '@core/page-tree'
import { TreeNode } from './TreeNode'
import { TreeBackgroundContextMenu } from './TreeBackgroundContextMenu'
import { useExpansionStore } from './DomTreeContext'
import { DomTreeProvider } from './DomTreeProvider'
import { DomPanelDndContext } from './DomPanelDndContext'
import { useDomPanelDnd } from './useDomPanelDnd'
import { TreeContainer, TreeIconSlot, TreeLabel, TreeRow } from '@site/ui/Tree'
import { TagPill } from '@ui/components/TagPill'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { isNarrowEditorChromeViewport } from '@site/layout/responsiveChrome'
import { SearchBar } from '@ui/components/SearchBar'
import { SkeletonTree } from '@ui/components/Skeleton'
import { Button } from '@ui/components/Button'
import { ModuleInserterDialog } from '@site/module-picker/ModuleInserterDialog'
import { useInsertInserterItem } from '@site/hooks/useInsertInserterItem'
import { AppGridPlusGlyphIcon } from 'pixel-art-icons/icons/app-grid-plus-glyph'
import type { IconComponent } from 'pixel-art-icons/types'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { ListBoxSolidIcon } from 'pixel-art-icons/icons/list-box-solid'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import styles from './DomPanel.module.css'

// ─── Search results (flat filtered list) ─────────────────────────────────────

interface SearchRow {
  nodeId: string
  displayName: string
  moduleId: string
  htmlTag: string | null
  classChip: string | null
}

interface SearchResultsProps {
  rows: SearchRow[]
  showTag: boolean
  showClasses: boolean
  onSelect: (nodeId: string) => void
}

function SearchResults({ rows, showTag, showClasses, onSelect }: SearchResultsProps) {
  if (rows.length === 0) {
    return (
      <div className={styles.noMatchMsg}>
        No elements match
      </div>
    )
  }
  return (
    <>
      {rows.map(({ nodeId, displayName, moduleId, htmlTag, classChip }) => (
        <TreeRow
          key={nodeId}
          depth={0}
          role="treeitem"
          aria-selected={false}
          tabIndex={0}
          onClick={() => onSelect(nodeId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onSelect(nodeId)
            }
          }}
        >
          <TreeIconSlot icon={getModuleIcon(moduleId)} iconSize={11} />
          {showTag && htmlTag && (
            <TagPill
              label={htmlTag}
              size="xs"
              monospace
              aria-hidden="true"
              className={styles.searchTagPill}
            />
          )}
          <TreeLabel>{displayName}</TreeLabel>
          {showClasses && classChip && (
            <TagPill
              label={classChip}
              size="xs"
              monospace
              aria-hidden="true"
              className={styles.searchClassChip}
            />
          )}
        </TreeRow>
      ))}
    </>
  )
}

// ─── Inner panel (needs context from DomTreeProvider) ─────────────────────────

function DomPanelInner({ editable = true }: { editable?: boolean }) {
  const page = useEditorStore(selectActiveCanvasPage)
  const activeDocument = useEditorStore((s) => s.activeDocument)
  const setFocusedPanel = useEditorStore((s) => s.setFocusedPanel)
  const focusedPanel = useEditorStore((s) => s.focusedPanel)
  // Per-node selector — only this ref updates when selection changes (Guideline #318)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  // Subscribe to the class registry + visualComponents so search results stay
  // accurate when classes are renamed or VCs are renamed (those affect the
  // searchable haystack and the chip text shown in results).
  const classes = useEditorStore((s) => s.site?.styleRules)
  const visualComponents = useEditorStore((s) => s.site?.visualComponents)

  // Tag / class display preferences. The SEARCH FILTER itself always considers
  // tag and class names regardless of these prefs — toggling visibility of
  // the chips should not silently change which rows match. The chips are
  // hidden in the results list when their pref is off so the search view
  // mirrors the live tree.
  const showTag = useEditorPreference('layersShowTag')
  const showClasses = useEditorPreference('layersShowClasses')
  // Behavioural prefs for the tree's reaction to canvas selection.
  const autoExpandSelected = useEditorPreference('layersAutoExpandSelected')
  const smoothScroll = useEditorPreference('layersSmoothScroll')

  const treeRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const insertTriggerRef = useRef<HTMLButtonElement>(null)
  const store = useExpansionStore()

  const [searchQuery, setSearchQuery] = useState('')

  // Module-insert affordance next to the search field. Reuses the exact same
  // command surface (ModuleInserterDialog) and target resolution
  // (useInsertInserterItem → resolveInsertLocation from the current selection)
  // as the canvas "+" and toolbar "+ Add" buttons, so all three entry points
  // insert identically.
  const [insertOpen, setInsertOpen] = useState(false)
  const handleInsertItem = useInsertInserterItem()

  // Right-click on the empty background of the tree area opens a small
  // context menu with Paste + Insert module options targeting the page root.
  // Per-row right-clicks are handled by `LayerNodeContextMenu` via `TreeNode`,
  // which calls `e.stopPropagation()` so this handler only fires on truly
  // empty space (padding around / below the rendered rows).
  const [bgContextMenu, setBgContextMenu] = useState<{ x: number; y: number } | null>(null)
  const rootNode = page?.nodes[page.rootNodeId] ?? null
  const hideStructuralRoot = activeDocument?.kind === 'visualComponent' && rootNode?.moduleId === 'base.body'
  const visibleRootNodeIds = page
    ? hideStructuralRoot
      ? rootNode?.children ?? []
      : [page.rootNodeId]
    : []

  // Panel landmark ref — used by the F6 focus-cycle effect to move focus into
  // the Layers tree. The Explorer shell owns positioning/visibility.
  const panelRef = useRef<HTMLDivElement>(null)

  // ─── DnD sensors ──────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },  // small threshold prevents accidental drags
    }),
  )

  const treeAreaRef = useRef<HTMLDivElement>(null)
  const dnd = useDomPanelDnd({ page, treeAreaRef, expandNode: store.expand, isExpanded: store.isExpanded })

  // ─── Ancestor auto-expand + scroll-to-selected ────────────────────────────
  // When the canvas selection changes, ensure the selected node is visible in
  // the tree (expand all its ancestors) and scroll the tree to it.
  //
  // `store` is the stable ExpansionStore instance from context — it never
  // changes reference for the lifetime of the DomTreeProvider. Listing it in
  // deps satisfies exhaustive-deps without ever causing effect re-runs.
  useEffect(() => {
    if (!page || !selectedNodeId) return

    // Auto-expand all ancestors of the selected node so it is visible in the
    // tree. Skipped when the user opts out via `layersAutoExpandSelected` —
    // the row remains hidden under collapsed parents until the user expands
    // them manually.
    if (autoExpandSelected) {
      const ancestorIds = getAncestorIds(page.nodes, page.rootNodeId, selectedNodeId)
      for (const ancestorId of ancestorIds) {
        store.expand(ancestorId)
      }
    }

    // Scroll the selected row into view after the expand animation settles.
    // The `smooth` vs `auto` choice is user-controllable via the
    // `layersSmoothScroll` preference (some users find smooth scrolling
    // distracting when bouncing between many nodes quickly).
    requestAnimationFrame(() => {
      const row = treeRef.current?.querySelector(`[data-node-id="${selectedNodeId}"]`)
      if (row) {
        row.scrollIntoView({
          behavior: smoothScroll ? 'smooth' : 'auto',
          block: 'nearest',
        })
      }
    })
  }, [selectedNodeId, page, autoExpandSelected, smoothScroll, store])

  // ─── Focus management: F6 moves focus into panel ──────────────────────────
  // The panel landmark is the landing target when the user cycles focus into
  // the DOM panel via F6. We must NOT pull focus to it when the
  // user has already clicked something inside the panel (e.g. the search
  // input on first interaction after page reload) — `focusedPanel` is
  // persisted, so this effect fires on every mount with `'domTree'` as the
  // default and races the user's click. The `panelRef.contains()` guard
  // prevents the steal.
  useEffect(() => {
    if (focusedPanel !== 'domTree') return
    const panel = panelRef.current
    if (!panel) return
    if (panel.contains(document.activeElement)) return
    panel.focus({ preventScroll: true })
  }, [focusedPanel, panelRef])

  // ─── Keyboard shortcuts at panel level ────────────────────────────────────
  const handlePanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'F6') {
      e.preventDefault()
      useEditorStore.getState().cycleFocusedPanel()
    }
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+E = expand all, Ctrl+W = collapse all
      if (e.key === 'e' && page) {
        e.preventDefault()
        store.expandAll(flattenSubtree(page, page.rootNodeId))
      }
      if (e.key === 'w') {
        e.preventDefault()
        store.collapseAll()
      }
      // Ctrl+F = focus search
      if (e.key === 'f') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
  }

  // ─── Background right-click → tree-background context menu ───────────────
  // Fires only for clicks on the empty padding/space of the tree area —
  // TreeNode's onContextMenu calls e.stopPropagation() so per-row right-clicks
  // don't reach this handler. Skipped while search is active because the
  // tree-mode UI (with its root anchor) isn't what's on screen.
  const handleBackgroundContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!editable) return
    if (searchQuery.trim()) return
    if (!page) return
    e.preventDefault()
    e.stopPropagation()
    setBgContextMenu({ x: e.clientX, y: e.clientY })
  }

  // ─── DnD drag-end: commit one validated move to store ────────────────────
  const handleDragEnd = (event: DragEndEvent) => {
    if (!editable) return
    const target = dnd.handleDragEnd(event)
    if (!target) return

    try {
      // Multi-drag: route to `moveNodes` so every dragged id is moved in a
      // single undo step. For single-drag, `target.draggedIds` is `[draggedId]`
      // and `moveNodes` collapses to `moveNode` internally.
      useEditorStore.getState().moveNodes(target.draggedIds, target.parentId, target.index)
    } catch (err) {
      console.warn('[DomPanel] Ignored stale drag/drop target:', err)
    }
  }

  // ─── Search: flat filtered list of matching nodes ─────────────────────────
  // Matches against the node's display name, its HTML tag (with optional `<>`
  // brackets the user might type), and any assigned class names (with optional
  // `.` prefix). Examples:
  //   "header"      → containers tagged <header> + nodes with class "header"
  //   "<div>"       → div containers and text/divs
  //   ".container"  → nodes with class "container" specifically
  //   "padding-m"   → nodes with class "padding-m"
  const searchRows: SearchRow[] = (() => {
    const rawQuery = searchQuery.trim().toLowerCase()
    if (!rawQuery || !page) return []

    // Normalize the query: strip a leading `<` / trailing `>` so users can
    // type "<div>" and still match the haystack which stores the bare tag.
    // Strip a leading `.` so ".container" matches "container" in class names.
    const query = rawQuery
      .replace(/^[<.]/, '')
      .replace(/>$/, '')

    return flattenSubtree(page, page.rootNodeId)
      .flatMap((nodeId) => {
        if (hideStructuralRoot && nodeId === page.rootNodeId) return []

        const node = page.nodes[nodeId]
        if (!node) return []
        const def = registry.get(node.moduleId)
        const displayName = getNodeDisplayName(node, def, visualComponents)
        const htmlTag = getNodeHtmlTag(node, def)
        const classNames = getNodeClassNames(node, classes)
        const classChip = classNames.length > 0 ? `.${classNames.join('.')}` : null

        // Build the searchable haystack from every visible piece of metadata.
        // Joined with spaces so substring matching works across fields without
        // accidentally matching across boundaries (e.g. "headerfooter").
        const haystackParts: string[] = [displayName.toLowerCase()]
        if (htmlTag) haystackParts.push(htmlTag)
        for (const name of classNames) haystackParts.push(name.toLowerCase())
        const haystack = haystackParts.join(' ')

        if (!haystack.includes(query)) return []

        return [{
          nodeId,
          displayName,
          moduleId: node.moduleId,
          htmlTag,
          classChip,
        } satisfies SearchRow]
      })
  })()

  const dragOverlay = (
    <DragOverlay dropAnimation={null}>
      {dnd.activeId && dnd.activeLabel && dnd.activeModuleId ? (
        <TreeRow depth={0} className={styles.dragOverlayRow}>
          <TreeIconSlot
            icon={getModuleIcon(dnd.activeModuleId)}
            iconSize={11}
            iconColor="var(--text-disabled)"
          />
          {dnd.activeCount > 1 ? (
            <TreeLabel>{dnd.activeCount} layers</TreeLabel>
          ) : (
            <TreeLabel>{dnd.activeLabel}</TreeLabel>
          )}
        </TreeRow>
      ) : null}
    </DragOverlay>
  )

  return (
    <div
      ref={panelRef}
      data-panel=""
      data-testid={page ? 'dom-panel-ready' : 'dom-panel'}
      role="complementary"
      aria-label="DOM tree panel"
      tabIndex={-1}
      onKeyDown={handlePanelKeyDown}
      onFocus={() => setFocusedPanel('domTree')}
      onClick={(e) => e.stopPropagation()}
      className={styles.panel}
    >
      {/* ─── Panel content. The ExplorerPanel shell owns the header + tabs +
          close button, so this body renders chrome-free. ────────────────── */}
      <>
        <div className={styles.searchRow}>
          <SearchBar
            ref={searchInputRef}
            data-testid="dom-tree-search"
            value={searchQuery}
            onValueChange={setSearchQuery}
            placeholder="Search layers…"
            aria-label="Search layers"
            className={styles.searchFill}
          />
          {editable && (
            <Button
              ref={insertTriggerRef}
              variant="secondary"
              size="sm"
              iconOnly
              aria-label="Insert module"
              aria-haspopup="dialog"
              aria-expanded={insertOpen}
              tooltip="Insert module"
              data-testid="dom-tree-insert-module"
              onClick={() => setInsertOpen(true)}
            >
              <AppGridPlusGlyphIcon size={13} aria-hidden="true" />
            </Button>
          )}
        </div>

        {/* ── Tree / search results — scrollable area ─────────────────────
            onContextMenu fires only for right-clicks on EMPTY space inside
            this scrollable area; TreeNode rows stop propagation so they
            keep their per-row context menu. */}
        <div
          ref={treeAreaRef}
          className={styles.treeArea}
          onContextMenu={handleBackgroundContextMenu}
        >
          {!page ? (
            <SkeletonTree ariaLabel="Loading layers" />
          ) : searchQuery.trim() ? (
            /* ── Search results mode: flat filtered list ── */
            <TreeContainer
              ariaLabel="Page element tree"
              testId="dom-panel-tree"
            >
              <SearchResults
                rows={searchRows}
                showTag={showTag}
                showClasses={showClasses}
                onSelect={(nodeId) =>
                  useEditorStore.getState().selectNode(nodeId, undefined, {
                    preservePropertiesPanelCollapse: isNarrowEditorChromeViewport(),
                  })}
              />
            </TreeContainer>
          ) : (
            /* ── Normal tree mode ── */
            <DndContext
              sensors={sensors}
              onDragStart={editable ? dnd.handleDragStart : undefined}
              onDragMove={editable ? dnd.handleDragMove : undefined}
              onDragEnd={handleDragEnd}
              onDragCancel={editable ? dnd.handleDragCancel : undefined}
            >
              <DomPanelDndContext.Provider value={dnd.contextValue}>
                <TreeContainer
                  ariaLabel="Page element tree"
                  testId="dom-panel-tree"
                  containerRef={treeRef}
                >
                  {/*
                    Page mode shows the `base.body` root because it represents
                    the document body and anchors page-level insertion.
                    Component mode hides that same structural wrapper and
                    promotes its children to top-level rows so the panel shows
                    authored component content instead of an implementation
                    anchor. Background insert/paste still targets the hidden
                    root through TreeBackgroundContextMenu.
                  */}
                  {visibleRootNodeIds.map((nodeId) => (
                    <TreeNode key={nodeId} nodeId={nodeId} depth={0} editable={editable} />
                  ))}
                </TreeContainer>
              </DomPanelDndContext.Provider>
              {typeof document === 'undefined'
                ? dragOverlay
                : createPortal(dragOverlay, document.body)}
            </DndContext>
          )}
        </div>
      </>

      {/* Tree-background context menu — rendered via portal at document.body
          to escape the panel's transform: translateZ(0) stacking context.
          Without the portal, position:fixed inside a transformed ancestor is
          positioned relative to that ancestor, not the viewport. */}
      {editable && bgContextMenu && createPortal(
        <TreeBackgroundContextMenu
          x={bgContextMenu.x}
          y={bgContextMenu.y}
          onClose={() => setBgContextMenu(null)}
        />,
        document.body,
      )}

      {/* Module inserter — same command surface + target resolution as the
          canvas "+" and toolbar "+ Add". */}
      {editable && insertOpen && (
        <ModuleInserterDialog
          onClose={() => {
            setInsertOpen(false)
            insertTriggerRef.current?.focus()
          }}
          onInsertItem={handleInsertItem}
        />
      )}
    </div>
  )
}

export function DomPanel({ editable = true }: { editable?: boolean }) {
  return (
    <DomTreeProvider>
      <DomPanelInner editable={editable} />
    </DomTreeProvider>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getModuleIcon(moduleId: string): IconComponent {
  switch (moduleId) {
    case 'base.container':
      return LayoutSolidIcon
    case 'base.text':
      return TextStartTIcon
    case 'base.image':
      return ImageSolidIcon
    case 'base.link':
      return LinkIcon
    case 'base.list':
      return ListBoxSolidIcon
    case 'base.body':
      return FileTextSolidIcon
    case 'base.video':
      return VideoSolidIcon
    case 'base.button':
    default:
      return SquareSolidIcon
  }
}
