/**
 * TreeNode — a single row in the DOM tree panel.
 *
 * Performance notes (Contribution #437 / Guideline #318):
 * - `React.memo` wrapping: re-renders only when nodeId or depth changes.
 * - Per-node isSelected / isHovered selectors: only the 2 affected rows
 *   re-render per canvas click (not all 1,000).
 * - Drag state tracked via refs; Zustand only updated on pointerUp (drag end).
 *
 * Drag-and-drop:
 * - Each TreeNode is a @dnd-kit draggable item with DOMPanel-owned targets.
 * - Visual indicators render as overlays (no DOM reorder during drag).
 * - moveNode() called once on DragEndEvent at the DomPanel level.
 *
 * Accessibility:
 * - role="treeitem" + aria-selected + aria-expanded on THE SAME element as
 *   tabIndex={0} and keyboard handlers (Guideline #234 / WCAG SC 4.1.2).
 * - onFocus/onBlur boxShadow focus ring (WCAG SC 2.4.7).
 * - height: 28px (Guideline #357 — compact density; WCAG 2.5.5 touch target
 *   NOT required for editor chrome per user directive / Guideline #357).
 * - Context menu focuses first item on mount.
 */
import { memo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { registry } from '@core/module-engine'
import {
  getNodeDisplayName,
  getNodeHtmlTag,
  getNodeClassNames,
} from '@core/page-tree'
import { useDraggable } from '@dnd-kit/core'
import { useExpansionStore, useIsNodeExpanded } from './DomTreeContext'
import { useDomPanelDndContext } from './DomPanelDndContext'
import { LayerNodeContextMenu } from './LayerNodeContextMenu'
import { Input } from '@ui/components/Input'
import { cn } from '@ui/cn'
import {
  TreeRow,
  treeDropStyles,
} from '@site/ui/Tree'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { LayerTreeNodeContent } from './LayerTreeNodeContent'
import styles from './TreeNode.module.css'

// Stable empty fallback for the children selector (keeps referential equality).
const EMPTY_CHILDREN: string[] = []

interface TreeNodeProps {
  nodeId: string
  depth: number
  editable?: boolean
}

interface ContextMenuState {
  x: number
  y: number
}

// React.memo re-render bailout — exception #2: hot, recursive per-node tree row
// rendered for every node in the document; skipping equal-prop re-renders here is
// an O(N) critical path the React Compiler's within-render memoization can't cover.
export const TreeNode = memo(function TreeNode({ nodeId, depth, editable = true }: TreeNodeProps) {
  // ── Per-node selectors — only THIS node re-renders on its own changes ──────
  const node = useEditorStore((s) => selectActiveCanvasPage(s)?.nodes[nodeId] ?? null)
  // Per-node selection: only the rows whose membership flips re-render per
  // selection event. With multi-select, several rows may flip in one event
  // (e.g. shift-click range), but each row still reads only its own boolean.
  const isSelected = useEditorStore((s) => s.selectedNodeIds.includes(nodeId))
  const isHovered = useEditorStore((s) => s.hoveredNodeId === nodeId)
  const isRoot = useEditorStore((s) => selectActiveCanvasPage(s)?.rootNodeId === nodeId)
  // Subscribe to visualComponents so VC renames re-render every ref's tree row
  // (the VC name is part of the resolved displayName for visual-component-ref nodes).
  const visualComponents = useEditorStore((s) => s.site?.visualComponents)
  // Subscribe to the class registry so renaming a class updates every row that
  // references it. The reference is stable across unrelated edits because
  // siteSlice mutations only swap classes when class state actually changes.
  const classes = useEditorStore((s) => s.site?.styleRules)

  // User preferences — controls visibility of the tag pill, class chip, and
  // module icon beside each row. Re-evaluated on storage / preferences-changed
  // events so toggling the Setting flips the layout instantly.
  const showIcon = useEditorPreference('layersShowIcon')
  const showTag = useEditorPreference('layersShowTag')
  const showClasses = useEditorPreference('layersShowClasses')

  // Delete confirmation — gated by `confirmBeforeDelete` preference. The
  // hook returns a function that either runs `commit` immediately (pref off)
  // or routes through the central confirm dialog (pref on).
  const confirmDelete = useConfirmDelete()

  const selectNode = useEditorStore((s) => s.selectNode)
  const hoverNode = useEditorStore((s) => s.hoverNode)
  const deleteNode = useEditorStore((s) => s.deleteNode)
  const duplicateNode = useEditorStore((s) => s.duplicateNode)
  const renameNode = useEditorStore((s) => s.renameNode)
  const wrapNode = useEditorStore((s) => s.wrapNode)
  const copyNode = useEditorStore((s) => s.copyNode)
  const cutNode = useEditorStore((s) => s.cutNode)
  const pasteNode = useEditorStore((s) => s.pasteNode)
  const openImportHtmlModal = useEditorStore((s) => s.openImportHtmlModal)

  const store = useExpansionStore()
  // Hooks must be called unconditionally — evaluate expandedSelf regardless of isRoot,
  // then gate with isRoot after the hook call (below, after the null guard).
  const expandedSelf = useIsNodeExpanded(nodeId)

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [isFocused, setIsFocused] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')

  const rowRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const { activeId, target, invalidOverId, registerRow } = useDomPanelDndContext()

  // ── dnd-kit draggable ─────────────────────────────────────────────────────
  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useDraggable({
    id: nodeId,
    disabled: !editable || !node || isRoot || node.locked || isRenaming,
  })

  const setRowNodeRef = (element: HTMLDivElement | null) => {
    rowRef.current = element
    setNodeRef(element)
    registerRow(nodeId, element)
  }

  // ── Guard against unmounted nodes ─────────────────────────────────────────
  if (!node) return null

  const definition = registry.get(node.moduleId)
  const displayName = getNodeDisplayName(node, definition, visualComponents)
  const htmlTag = getNodeHtmlTag(node, definition)
  const classNames = getNodeClassNames(node, classes)
  const hasChildren = node.children.length > 0
  // The page body is the root of the page tree — the only top-level row, so
  // collapsing it would just hide the entire document. Force it open and hide
  // its chevron — the row is purely a label for "the page body", with no
  // expand/collapse affordance.
  const expanded = isRoot ? true : expandedSelf
  const isOpenContainerGroup = node.moduleId === 'base.container' && hasChildren && expanded && isSelected
  const dropPosition =
    target?.overId === nodeId && target.position !== 'inside'
      ? target.position
      : target?.parentId === nodeId && target.position === 'inside'
        ? 'inside'
        : undefined

  // ── Keyboard navigation ───────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // When the rename input is active, all key handling is delegated to
    // handleRenameKeyDown on the input itself — don't intercept here.
    if (isRenaming) return
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault()
        selectNode(nodeId)
        if (hasChildren && !isRoot) store.toggle(nodeId)
        break
      case 'ArrowRight':
        e.preventDefault()
        if (hasChildren && !isRoot && !expanded) store.toggle(nodeId)
        break
      case 'ArrowLeft':
        e.preventDefault()
        if (!isRoot && expanded) store.toggle(nodeId)
        break
      case 'F2':
        if (!editable) return
        e.preventDefault()
        openRename()
        break
    }
  }

  // ── Inline rename ─────────────────────────────────────────────────────────
  const openRename = () => {
    if (!editable) return
    setRenameValue(node.label ?? displayName)
    setIsRenaming(true)
    setContextMenu(null)
    // Focus the input after it renders
    requestAnimationFrame(() => renameInputRef.current?.select())
  }

  const commitRename = () => {
    if (!editable) {
      setIsRenaming(false)
      return
    }
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== displayName) {
      renameNode(nodeId, trimmed)
    }
    setIsRenaming(false)
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // stopPropagation prevents bubbling to the parent row's handleKeyDown,
    // which would otherwise intercept Enter/Space and call selectNode().
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitRename() }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setIsRenaming(false) }
  }

  // Joined class chip (e.g. ".header.padding-m") — chained CSS-selector style.
  // CSS truncates with an ellipsis when there isn't enough horizontal room.
  const classSelectorChip = classNames.length > 0 ? `.${classNames.join('.')}` : null

  return (
    // Wrapper preserves the recursive tree shape. DnD refs live on TreeRow so
    // hit-testing uses the actual visible row height.
    <div
      data-node-id={nodeId}
      data-open-container-group={isOpenContainerGroup ? 'true' : undefined}
      className={cn(
        node.moduleId === 'base.slot-instance' && styles.slotInstanceRow,
        isOpenContainerGroup && styles.openContainerGroup,
        activeId === nodeId && styles.dragSource,
      )}
    >
      {/* ── Row: role="treeitem" + tabIndex + handlers all on ONE element ── */}
      {/*
          IMPORTANT: {…attributes} from useSortable injects role="button".
          role="treeitem" is placed AFTER the spread to override it back
          (Guideline #234 / WAI-ARIA tree pattern — treeitem role is non-negotiable).
      */}
      <TreeRow
        ref={setRowNodeRef}
        depth={depth}
        selected={isSelected}
        hovered={isHovered}
        focused={isFocused}
        locked={node.locked}
        hidden={node.hidden}
        dragging={isDragging}
        className={cn(
          dropPosition === 'before' && treeDropStyles.dropBefore,
          dropPosition === 'after' && treeDropStyles.dropAfter,
          dropPosition === 'inside' && treeDropStyles.dropInside,
          invalidOverId === nodeId && treeDropStyles.dropInvalid,
        )}
        {...attributes}
        {...listeners}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={hasChildren && !isRoot ? expanded : undefined}
        // aria-label names the row for AT, including locked/hidden state so screen
        // reader users get the full picture without relying on the emoji indicators
        // (which are aria-hidden and therefore invisible to AT).
        aria-label={[
          displayName,
          node.locked ? 'locked' : null,
          node.hidden ? 'hidden' : null,
        ].filter(Boolean).join(', ')}
        data-drop-position={dropPosition}
        // Stable agent-addressable handles. `dom-tree-item` is keyed by the
        // node id (matches `data-instatic-node-id` on the canvas) so a single id
        // round-trips between the canvas and the layers tree. `data-instatic-tag`
        // mirrors the resolved HTML tag so agents can disambiguate two
        // "Container" rows by `[data-instatic-tag="nav"]` vs `[data-instatic-tag="footer"]`.
        data-testid={`dom-tree-item-${nodeId}`}
        data-instatic-node-id={nodeId}
        data-instatic-tag={htmlTag ?? undefined}
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation()
          // Modifier-aware selection (multi-select): Cmd/Ctrl-click toggles,
          // Shift-click extends a range from the anchor. Modifier-clicks do
          // NOT toggle expansion — that's reserved for plain clicks so users
          // can build a multi-selection without accidentally rearranging the
          // tree's visible structure.
          if (e.shiftKey) {
            selectNode(nodeId, 'range')
            return
          }
          if (e.metaKey || e.ctrlKey) {
            selectNode(nodeId, 'toggle')
            return
          }
          selectNode(nodeId)
          if (hasChildren && !isRoot) store.toggle(nodeId)
        }}
        onDoubleClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          openRename()
        }}
        onKeyDown={handleKeyDown}
        onContextMenu={(e) => {
          e.preventDefault(); e.stopPropagation()
          if (!editable) return
          // Right-click on a node already in the multi-selection keeps the set;
          // otherwise replace with just this node. Matches the canvas + Figma.
          const currentIds = useEditorStore.getState().selectedNodeIds
          if (!currentIds.includes(nodeId)) {
            selectNode(nodeId)
          }
          setContextMenu({ x: e.clientX, y: e.clientY })
        }}
        onMouseEnter={() => hoverNode(nodeId)}
        onMouseLeave={() => hoverNode(null)}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
      >
        <LayerTreeNodeContent
          moduleId={node.moduleId}
          displayName={displayName}
          htmlTag={htmlTag}
          classSelectorChip={classSelectorChip}
          hasChildren={hasChildren}
          expanded={expanded}
          showIcon={showIcon}
          showTag={showTag}
          showClasses={showClasses}
          isRoot={isRoot}
          locked={node.locked}
          hidden={node.hidden}
          onToggle={(e) => { e.stopPropagation(); if (!isRoot) store.toggle(nodeId) }}
          labelSlot={isRenaming ? (
            <Input
              ref={renameInputRef}
              fieldSize="xs"
              // autoFocus ensures the input receives keyboard focus as soon as it
              // mounts — more reliable than the requestAnimationFrame fallback.
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={commitRename}
              // Stop pointer events from bubbling to the row's dnd-kit listeners.
              // Without this, a click inside the input triggers the PointerSensor
              // on the row div, which can steal focus away from the input.
              onPointerDown={(e) => e.stopPropagation()}
              aria-label={`Rename ${displayName}`}
              className={styles.renameInput}
            />
          ) : undefined}
        />
      </TreeRow>

      {/* Children — role="group" as required by WAI-ARIA tree pattern */}
      {hasChildren && expanded && (
        <ChildrenGroup nodeId={nodeId} depth={depth} editable={editable} />
      )}

      {/* Context menu — rendered via portal at document.body to escape the
          DomPanel's transform: translateZ(0) stacking context.
          Without the portal, position:fixed inside a transformed ancestor is
          positioned relative to that ancestor, not the viewport, causing the
          menu to appear ~40px below the cursor (Task #413). */}
      {editable && contextMenu && createPortal(
        <LayerNodeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          nodeId={nodeId}
          onClose={() => setContextMenu(null)}
          onDelete={() => {
            setContextMenu(null)
            confirmDelete({
              title: 'Delete layer?',
              description: `${displayName} and any of its children will be removed. This can be undone with Ctrl/Cmd+Z.`,
              commit: () => deleteNode(nodeId),
            })
          }}
          onDuplicate={() => { duplicateNode(nodeId); setContextMenu(null) }}
          onRename={() => { setContextMenu(null); openRename() }}
          onWrapInContainer={() => {
            wrapNode(nodeId, 'base.container')
            setContextMenu(null)
          }}
          onCopy={() => { copyNode(nodeId); setContextMenu(null) }}
          onCut={() => { cutNode(nodeId); setContextMenu(null) }}
          onPaste={() => { pasteNode(nodeId); setContextMenu(null) }}
          onPasteHtml={async (targetNodeId) => {
            setContextMenu(null)
            let prefillHtml = ''
            try {
              prefillHtml = await navigator.clipboard.readText()
            } catch (_err) {
              // Clipboard permission denied or API unavailable — open with an empty editor.
            }
            openImportHtmlModal({ parentId: targetNodeId, prefillHtml })
          }}
        />,
        document.body,
      )}
    </div>
  )
})

// ─── ChildrenGroup — recursive child rendering ───────────────────────────────

import { useEditorStore as useStore } from '@site/store/store'

function ChildrenGroup({ nodeId, depth, editable }: { nodeId: string; depth: number; editable: boolean }) {
  // Fall back to a module-level stable empty array: returning a fresh [] from
  // the selector would break referential equality every render (Guideline #239).
  const children = useStore((s) => selectActiveCanvasPage(s)?.nodes[nodeId]?.children) ?? EMPTY_CHILDREN

  return (
    <div role="group">
      {children.map((childId) => (
        <TreeNode key={childId} nodeId={childId} depth={depth + 1} editable={editable} />
      ))}
    </div>
  )
}
