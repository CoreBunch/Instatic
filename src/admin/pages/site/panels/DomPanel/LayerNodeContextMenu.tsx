/**
 * LayerNodeContextMenu — right-click menu for nodes in the DOM panel and
 * canvas. Hosts rename / duplicate / componentize / save-as-layout / cut /
 * copy / paste / wrap / delete
 * actions and an "Insert module here" `ContextMenuSubmenu` that shows the
 * shared `ModulePicker` (search + categorized module list, including site
 * Visual Components) as a true second-level dropdown — same primitive,
 * same styling, same hover/focus/colors as every other submenu.
 *
 * The submenu is *always* offered: every node is a legal target, because the
 * shared `resolveInsertLocation` helper (in `@site/store/insertLocation`)
 * places the new node inside container targets and as a sibling-after under
 * the parent of leaf targets (Text, Button, Image, etc.). Without that
 * fallback the right-click flow used to silently no-op on leaf nodes — see
 * `LayerNodeContextMenu — sibling fallback` tests for the regression gate.
 *
 * The Paste item is rendered conditionally: it appears only when the
 * clipboard slice has a captured subtree. The clipboard is editor-wide and
 * persisted to localStorage, so it can survive page reloads.
 *
 * Multi-select awareness:
 * - When multiple nodes are selected AND the right-clicked node is part of
 *   that selection, the menu acts on every selected node:
 *     - Rename → hidden (only meaningful for one node).
 *     - Duplicate / Copy / Cut / Wrap / Delete → multi-aware actions.
 *     - "Insert module here" → hidden (anchored to one parent).
 * - Wrap is now a SUBMENU with two choices: Container and Loop. The
 *   underlying action is `wrapNode` (single) or `wrapNodes` (multi, with
 *   closest-common-ancestor semantics).
 *
 * Architecture gate (G4, G5): Visual Component insertion MUST go through the
 * shared `insertComponentRef` action in `siteSlice` so cycle detection and
 * VC/page-mode dispatch are applied uniformly.
 * See `src/__tests__/architecture/component-system-placement.test.ts`.
 */

import { useEffect, useRef } from 'react'
import {
  ContextMenu as UIContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSubmenu,
} from '@ui/components/ContextMenu'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { useShallow } from 'zustand/react/shallow'
import { registry } from '@core/module-engine'
import { useInsertModule } from '@site/hooks/useInsertModule'
import { useInsertFormPreset } from '@site/hooks/useInsertFormPreset'
import { resolveInsertLocation } from '@site/store/insertLocation'
import { ModulePicker } from '@site/module-picker'
import { canComponentizeNode } from '@site/componentization'
import type { FormPreset } from '@site/module-picker'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import type { AnyModuleDefinition } from '@core/module-engine'
import { PenSquareSolidIcon } from 'pixel-art-icons/icons/pen-square-solid'
import { CopyPlusSolidIcon } from 'pixel-art-icons/icons/copy-plus-solid'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { CopyXSolidIcon } from 'pixel-art-icons/icons/copy-x-solid'
import { FilesStack2SolidIcon } from 'pixel-art-icons/icons/files-stack-2-solid'
import { CheckboxSolidIcon } from 'pixel-art-icons/icons/checkbox-solid'
import { ContainerSolidIcon } from 'pixel-art-icons/icons/container-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { AppGridPlusGlyphIcon } from 'pixel-art-icons/icons/app-grid-plus-glyph'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { BoxSolidIcon } from 'pixel-art-icons/icons/box-solid'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import styles from './LayerNodeContextMenu.module.css'

interface LayerNodeContextMenuProps {
  x: number
  y: number
  onClose: () => void
  /**
   * Single-node delete handler (used when the selection has one node).
   * Multi-delete is dispatched internally via `deleteNodes` to avoid each
   * caller wiring a separate confirm dialog for the multi-case — see comment
   * inside the component for the rationale.
   */
  onDelete: () => void
  onDuplicate: () => void
  onRename: () => void
  /** Single-node wrap handler. Multi-wrap is dispatched internally. */
  onWrapInContainer: () => void
  onCopy: () => void
  onCut: () => void
  onPaste: () => void
  /**
   * Called when the user clicks "Paste HTML here…" on a container node.
   * Only rendered for single-selection container nodes (root or canHaveChildren).
   * The callback receives the nodeId to use as the insertion parent.
   */
  onPasteHtml?: (nodeId: string) => void
  /** The node that was right-clicked. When omitted, falls back to selectedNodeId. */
  nodeId?: string
}

export function LayerNodeContextMenu({
  x,
  y,
  onClose,
  onDelete,
  onDuplicate,
  onRename,
  onWrapInContainer,
  onCopy,
  onCut,
  onPaste,
  onPasteHtml,
  nodeId: nodeIdProp,
}: LayerNodeContextMenuProps) {
  const firstItemRef = useRef<HTMLButtonElement>(null)

  // Per-node selector — fallback for nodeId when no explicit prop is given.
  // CanvasRoot / TreeNode select the right-clicked node before opening the menu,
  // so selectedNodeId is reliable there even without an explicit nodeId prop.
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  // Multi-select awareness: when 2+ nodes are selected, the menu acts on the
  // whole set. `useShallow` keeps subscriptions stable for content equality.
  const selectedNodeIds = useEditorStore(useShallow((s) => s.selectedNodeIds))
  const insertComponentRef = useEditorStore((s) => s.insertComponentRef)
  const openComponentizeEditor = useEditorStore((s) => s.openComponentizeEditor)
  const insertModule = useInsertModule()
  const wrapNodesAction = useEditorStore((s) => s.wrapNodes)
  const duplicateNodesAction = useEditorStore((s) => s.duplicateNodes)
  const copyNodesAction = useEditorStore((s) => s.copyNodes)
  const cutNodesAction = useEditorStore((s) => s.cutNodes)
  const deleteNodesAction = useEditorStore((s) => s.deleteNodes)
  const activePage = useEditorStore(selectActiveCanvasPage)
  const confirmDelete = useConfirmDelete()

  // Reactive boolean for the conditional Paste item — re-renders whenever
  // the clipboard entry transitions between null and non-null.
  const canPaste = useEditorStore((s) => s.clipboardEntry !== null)

  const nodeId = nodeIdProp ?? selectedNodeId

  // Resolve whether we're acting on a multi-selection. The menu is "multi"
  // only when the right-clicked nodeId is part of an existing 2+ selection.
  // Right-clicking outside a multi-selection demotes back to single-select
  // (the calling site already replaced selection in that case — see
  // CanvasRoot.onNodeContextMenu and TreeNode's onContextMenu).
  const isMulti = selectedNodeIds.length > 1 && nodeId !== null && selectedNodeIds.includes(nodeId)
  const targetIds = isMulti ? selectedNodeIds : nodeId ? [nodeId] : []

  // slot-instance structural lock-down — Task 5
  //
  // A `base.slot-instance` node is structural ONLY when its parent is a
  // `base.visual-component-ref` — that is the only context in which it is
  // managed by `syncSlotInstances` and must not be deleted/moved/renamed by
  // hand. An orphan slot-instance anywhere else (e.g. left over from a
  // parallel session before the picker filter was added) is just a regular
  // node the user must be able to delete to recover.
  const lockedSlotInstance = useEditorStore((s) => {
    if (isMulti) return false  // Multi-select already filters slot-instance per slice rules.
    if (!nodeId) return false
    const tree = selectActiveCanvasPage(s)
    if (!tree) return false
    const node = tree.nodes[nodeId]
    if (!node || node.moduleId !== 'base.slot-instance') return false
    // Find the parent. Locked only when parent is a VC ref.
    const parent = Object.values(tree.nodes).find((n) =>
      n.children.includes(nodeId),
    )
    return parent?.moduleId === 'base.visual-component-ref'
  })

  // Whether the right-clicked node accepts children (root or canHaveChildren).
  // Used to gate the "Paste HTML here…" item — only offered when the target
  // is a genuine container so the import lands where the user expects it.
  const isContainer = useEditorStore((s) => {
    if (isMulti || !nodeId) return false
    const tree = selectActiveCanvasPage(s)
    if (!tree) return false
    const isRoot = tree.rootNodeId === nodeId
    const node = tree.nodes[nodeId]
    if (!node) return false
    const def = registry.get(node.moduleId)
    return isRoot || def?.canHaveChildren === true
  })

  const canComponentize = useEditorStore((s) => {
    if (isMulti || !nodeId) return false
    const tree = selectActiveCanvasPage(s)
    const node = tree?.nodes[nodeId]
    return canComponentizeNode(s.activeDocument, node)
  })

  // "Save as layout" mirrors Componentize's mode gate (page mode, single
  // selection) but stays VISIBLE on the page root — disabled with the reason
  // inline, so authors learn why the whole body can't be a layout.
  const isPageRoot = nodeId !== null && activePage?.rootNodeId === nodeId
  const showSaveAsLayout = useEditorStore((s) => {
    if (isMulti || !nodeId || lockedSlotInstance) return false
    if (s.activeDocument?.kind === 'visualComponent') return false
    return selectActiveCanvasPage(s)?.nodes[nodeId] !== undefined
  })

  const dispatchSaveAsLayout = () => {
    if (!nodeId) return
    useEditorStore.getState().openLayoutNameDialog({ mode: 'create', nodeId })
    onClose()
  }

  const hideActionTargetIds = targetIds.filter((id) => id !== activePage?.rootNodeId)
  const canToggleHidden = !lockedSlotInstance && hideActionTargetIds.length > 0
  const shouldHideSelection = hideActionTargetIds.some((id) => !activePage?.nodes[id]?.hidden)
  const hideActionLabel = isMulti
    ? shouldHideSelection ? 'Hide selected' : 'Unhide selected'
    : shouldHideSelection ? 'Hide' : 'Unhide'

  // "Insert module here" is hidden ONLY for multi-select (the new node has no
  // single anchor in that case) — for single-select every node is a legal
  // target because resolveInsertLocation handles container vs. leaf targets
  // uniformly (leaves land as sibling-after under their parent).
  const showInsertHere = !isMulti && nodeId !== null

  useEffect(() => {
    firstItemRef.current?.focus()
  }, [])

  const handleSelectModule = (mod: AnyModuleDefinition) => {
    if (!nodeId) return
    insertModule(mod, nodeId)
  }

  const insertFormPreset = useInsertFormPreset()

  const handleSelectFormPreset = (preset: FormPreset) => {
    if (!nodeId) return
    insertFormPreset(preset, nodeId)
  }

  const handleSelectVC = (vcId: string) => {
    if (!nodeId) return
    // Mirror useInsertModule's resolution so VC drops obey the same
    // "sibling-after on a leaf target" rule that the module submenu uses.
    const page = selectActiveCanvasPage(useEditorStore.getState())
    if (!page) return
    const location = resolveInsertLocation(page, nodeId)
    if (!location) return
    insertComponentRef(location.parentId, vcId, location.index)
  }

  // Multi-aware action dispatchers. For single-select they delegate to the
  // pre-existing single-node handlers (which carry their own UX: rename
  // dialog, confirm-delete dialog, etc.); for multi-select they call the
  // *Nodes batch actions directly.
  const dispatchDuplicate = () => {
    if (isMulti) {
      duplicateNodesAction(targetIds)
      onClose()
    } else {
      onDuplicate()
    }
  }

  const dispatchCopy = () => {
    if (isMulti) {
      copyNodesAction(targetIds)
      onClose()
    } else {
      onCopy()
    }
  }

  const dispatchCut = () => {
    if (isMulti) {
      cutNodesAction(targetIds)
      onClose()
    } else {
      onCut()
    }
  }

  const dispatchToggleHidden = () => {
    const { toggleNodeHidden } = useEditorStore.getState()
    for (const id of hideActionTargetIds) {
      const currentHidden = Boolean(activePage?.nodes[id]?.hidden)
      if (currentHidden !== shouldHideSelection) {
        toggleNodeHidden(id)
      }
    }
    onClose()
  }

  const dispatchDelete = () => {
    if (isMulti) {
      const idsToDelete = [...targetIds]
      confirmDelete({
        title: 'Delete layers?',
        description: `${idsToDelete.length} layers (and their children) will be removed. This can be undone with Ctrl/Cmd+Z.`,
        confirmLabel: 'Delete',
        commit: () => deleteNodesAction(idsToDelete),
      })
      onClose()
    } else {
      onDelete()
    }
  }

  const dispatchWrapInContainer = () => {
    if (isMulti) {
      wrapNodesAction(targetIds, 'base.container')
      onClose()
    } else {
      onWrapInContainer()
    }
  }

  const dispatchComponentize = () => {
    if (!nodeId) return
    openComponentizeEditor(nodeId)
    onClose()
  }

  const dispatchWrapInLoop = () => {
    if (isMulti) {
      wrapNodesAction(targetIds, 'base.loop')
    } else if (nodeId) {
      useEditorStore.getState().wrapNode(nodeId, 'base.loop')
    }
    onClose()
  }

  // Selection-count chip in the menu header (multi only). Lives as a
  // disabled menuitem-equivalent label so screen readers can read "3 layers
  // selected" before announcing the action items.
  const headerLabel = isMulti ? `${selectedNodeIds.length} layers selected` : null

  return (
    <UIContextMenu
      x={x}
      y={y}
      ariaLabel={headerLabel ?? 'Node options'}
      animateExit
      onClose={onClose}
    >
      {headerLabel && (
        <>
          <div role="presentation" className={styles.headerChip}>
            {headerLabel}
          </div>
          <ContextMenuSeparator />
        </>
      )}

      {canToggleHidden && (
        <>
          <ContextMenuItem ref={firstItemRef} onClick={dispatchToggleHidden}>
            <span aria-hidden="true"><EyeSolidIcon size={13} /></span>
            {hideActionLabel}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}

      {/* Rename — hidden for slot-instance lockdown AND for multi-select
          (rename is single-node only). */}
      {!lockedSlotInstance && !isMulti && (
        <ContextMenuItem ref={canToggleHidden ? undefined : firstItemRef} onClick={onRename}>
          <span aria-hidden="true"><PenSquareSolidIcon size={13} /></span>
          Rename
        </ContextMenuItem>
      )}

      {!lockedSlotInstance && (
        <>
          <ContextMenuItem
            ref={!canToggleHidden && isMulti ? firstItemRef : undefined}
            onClick={dispatchDuplicate}
          >
            <span aria-hidden="true"><CopyPlusSolidIcon size={13} /></span>
            Duplicate
          </ContextMenuItem>

          {canComponentize && (
            <ContextMenuItem onClick={dispatchComponentize}>
              <span aria-hidden="true"><BoxSolidIcon size={13} /></span>
              Componentize
            </ContextMenuItem>
          )}

          {showSaveAsLayout && (
            <ContextMenuItem
              onClick={dispatchSaveAsLayout}
              disabled={isPageRoot}
              title={isPageRoot ? 'The page body cannot be saved as a layout — save a section inside it instead.' : undefined}
            >
              <span aria-hidden="true"><LayoutSolidIcon size={13} /></span>
              Save as layout…
            </ContextMenuItem>
          )}

          <ContextMenuSeparator />

          <ContextMenuItem onClick={dispatchCopy}>
            <span aria-hidden="true"><CopySolidIcon size={13} /></span>
            Copy
          </ContextMenuItem>

          <ContextMenuItem onClick={dispatchCut}>
            <span aria-hidden="true"><CopyXSolidIcon size={13} /></span>
            Cut
          </ContextMenuItem>

          {canPaste && (
            <ContextMenuItem onClick={onPaste}>
              <span aria-hidden="true"><FilesStack2SolidIcon size={13} /></span>
              Paste
            </ContextMenuItem>
          )}

          {!isMulti && isContainer && onPasteHtml && nodeId && (
            <ContextMenuItem onClick={() => { onPasteHtml(nodeId); onClose() }}>
              <span aria-hidden="true"><CodeIcon size={13} /></span>
              Paste HTML here…
            </ContextMenuItem>
          )}

          <ContextMenuSeparator />

          {/* Wrap is now a submenu with Container / Loop choices. Same UX in
              single- and multi-select — for multi the closest common ancestor
              is computed by `wrapNodes` so cross-parent selections become a
              single wrapper at the right tree level. */}
          <ContextMenuSubmenu
            label="Wrap in"
            icon={<ContainerSolidIcon size={13} />}
            onClose={onClose}
            width={200}
          >
            <ContextMenuItem onClick={dispatchWrapInContainer}>
              <span aria-hidden="true"><CheckboxSolidIcon size={13} /></span>
              Container
            </ContextMenuItem>
            <ContextMenuItem onClick={dispatchWrapInLoop}>
              <span aria-hidden="true"><BoxStackSolidIcon size={13} /></span>
              Loop
            </ContextMenuItem>
          </ContextMenuSubmenu>
        </>
      )}

      {/*
        "Insert module here" is hidden only for multi-select (the new node has
        no single anchor when 2+ layers are selected). For single-select it is
        always offered: container targets receive the new node as a last child,
        leaf targets (Text, Button, Image, etc.) receive a sibling-after under
        their parent — resolved by `resolveInsertLocation`.
      */}
      {showInsertHere && (
        <ContextMenuSubmenu
          label="Insert module here"
          icon={<AppGridPlusGlyphIcon size={13} />}
          onClose={onClose}
          width={280}
          maxHeight={420}
          // The submenu hosts a search input — clicks on the input must not
          // dismiss the panel. Only menuitem clicks (i.e. picking a module/VC)
          // should close.
          closeOnItemClickOnly
        >
          <ModulePicker
            onSelectModule={handleSelectModule}
            onSelectFormPreset={handleSelectFormPreset}
            onSelectVC={handleSelectVC}
          />
        </ContextMenuSubmenu>
      )}

      {!lockedSlotInstance && (
        <>
          <ContextMenuSeparator />

          <ContextMenuItem danger onClick={dispatchDelete}>
            <span aria-hidden="true"><TrashSolidIcon size={13} /></span>
            Delete
          </ContextMenuItem>
        </>
      )}
    </UIContextMenu>
  )
}
