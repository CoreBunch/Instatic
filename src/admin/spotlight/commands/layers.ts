/**
 * Layers commands — §4.4 of the Command Spotlight master plan.
 *
 * All commands operate on the currently selected node(s) in the editor.
 * Gated by workspace:'site' and when: selectedNodeIds.length > 0.
 *
 * Phase 2 commands:
 *   - Duplicate selected layer
 *   - Delete selected layer (destructive)
 *   - Copy / Cut / Paste layer
 *   - Rename layer (arg: label)
 *   - Lock / Unlock layer
 *   - Hide / Show layer
 *   - Wrap in container
 *   - Move up / Move down
 *   - Select parent / first child / next sibling / previous sibling
 *   - Convert selection to Visual Component
 */

import { getParent } from '@core/page-tree'
import type { Command, CommandRunContext } from '../types'

const hasSelection = (ctx: { editor?: { selectedNodeIds: ReadonlyArray<string> } }) =>
  (ctx.editor?.selectedNodeIds.length ?? 0) > 0

async function getActiveLayerTree() {
  const { useEditorStore, selectActiveCanvasPage } = await import('@site/store/store')
  const store = useEditorStore.getState()
  return { store, page: selectActiveCanvasPage(store) }
}

type LayerMoveDirection = 'up' | 'down'

/**
 * Resolve a one-step sibling move for the current selection.
 *
 * Multi-selection is treated as one ordered block. Nested selections collapse
 * to their selected ancestors, and selections spanning different parents are
 * left untouched because one sibling move cannot represent that operation.
 */
function resolveSelectedSiblingMove(
  page: NonNullable<Awaited<ReturnType<typeof getActiveLayerTree>>['page']>,
  selectedNodeIds: readonly string[],
  direction: LayerMoveDirection,
): { nodeIds: string[]; parentId: string; newIndex: number } | null {
  const selected = new Set(selectedNodeIds)
  const topLevelIds = selectedNodeIds.filter((id) => {
    if (!page.nodes[id] || id === page.rootNodeId) return false
    let ancestor = getParent(page, id)
    while (ancestor) {
      if (selected.has(ancestor.id)) return false
      ancestor = getParent(page, ancestor.id)
    }
    return true
  })
  if (topLevelIds.length === 0) return null

  const parents = topLevelIds.map((id) => getParent(page, id))
  if (parents.some((parent) => !parent)) return null
  const parentId = parents[0]!.id
  if (parents.some((parent) => parent!.id !== parentId)) return null

  const topLevelSet = new Set(topLevelIds)
  const nodeIds = parents[0]!.children.filter((id) => topLevelSet.has(id))
  if (nodeIds.length === 0) return null

  const firstIndex = parents[0]!.children.indexOf(nodeIds[0]!)
  const lastIndex = parents[0]!.children.indexOf(nodeIds[nodeIds.length - 1]!)
  if (direction === 'up' && firstIndex <= 0) return null
  if (direction === 'down' && lastIndex >= parents[0]!.children.length - 1) return null

  return {
    nodeIds,
    parentId,
    newIndex: direction === 'up' ? firstIndex - 1 : firstIndex + 1,
  }
}

async function moveSelectedLayers(ctx: CommandRunContext, direction: LayerMoveDirection): Promise<void> {
  ctx.closeSpotlight()
  const selectedNodeIds = ctx.editor?.selectedNodeIds ?? []
  if (selectedNodeIds.length === 0) return

  try {
    const { store, page } = await getActiveLayerTree()
    if (!page) return
    const target = resolveSelectedSiblingMove(page, selectedNodeIds, direction)
    if (!target) return
    store.moveNodes(target.nodeIds, target.parentId, target.newIndex)
  } catch (err) {
    console.error(`[spotlight] moveNode ${direction} failed:`, err)
  }
}

export function getLayersCommands(): Command[] {
  return [
    // ── Duplicate layer ──────────────────────────────────────────────────────
    {
      id: 'layers.duplicate',
      title: 'Duplicate layer',
      subtitle: 'Duplicate the selected layer',
      group: 'editor',
      iconName: 'copy-2-solid',
      keywords: ['layer', 'duplicate', 'copy', 'clone'],
      workspaces: ['site'],
      capability: 'site.structure.edit',
      when: hasSelection,
      priorityBoost: 1.1,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const ids = ctx.editor?.selectedNodeIds ?? []
        if (ids.length === 0) return
        try {
          const { useEditorStore } = await import('@site/store/store')
          const store = useEditorStore.getState()
          if (ids.length === 1) {
            store.duplicateNode(ids[0]!)
          } else {
            store.duplicateNodes([...ids])
          }
        } catch (err) {
          console.error('[spotlight] duplicateNode failed:', err)
        }
      },
    },

    // ── Delete layer ─────────────────────────────────────────────────────────
    {
      id: 'layers.delete',
      title: 'Delete layer',
      subtitle: 'Remove the selected layer from the page',
      group: 'editor',
      iconName: 'trash-solid',
      keywords: ['layer', 'delete', 'remove', 'destroy'],
      workspaces: ['site'],
      capability: 'site.structure.edit',
      when: hasSelection,
      destructive: true,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const ids = ctx.editor?.selectedNodeIds ?? []
        if (ids.length === 0) return
        try {
          const { useEditorStore } = await import('@site/store/store')
          const store = useEditorStore.getState()
          if (ids.length === 1) {
            store.deleteNode(ids[0]!)
          } else {
            store.deleteNodes([...ids])
          }
        } catch (err) {
          console.error('[spotlight] deleteNode failed:', err)
        }
      },
    },

    // ── Copy layer ───────────────────────────────────────────────────────────
    {
      id: 'layers.copy',
      title: 'Copy layer',
      subtitle: 'Copy the selected layer to the clipboard',
      group: 'editor',
      iconName: 'copy-solid',
      keywords: ['layer', 'copy', 'clipboard'],
      workspaces: ['site'],
      capability: 'site.read',
      when: hasSelection,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const ids = ctx.editor?.selectedNodeIds ?? []
        if (ids.length === 0) return
        try {
          const { useEditorStore } = await import('@site/store/store')
          const store = useEditorStore.getState()
          if (ids.length === 1) {
            store.copyNode(ids[0]!)
          } else {
            store.copyNodes([...ids])
          }
        } catch (err) {
          console.error('[spotlight] copyNode failed:', err)
        }
      },
    },

    // ── Cut layer ────────────────────────────────────────────────────────────
    {
      id: 'layers.cut',
      title: 'Cut layer',
      subtitle: 'Cut the selected layer to the clipboard',
      group: 'editor',
      iconName: 'copy-x-solid',
      keywords: ['layer', 'cut', 'clipboard', 'remove'],
      workspaces: ['site'],
      capability: 'site.structure.edit',
      when: hasSelection,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const ids = ctx.editor?.selectedNodeIds ?? []
        if (ids.length === 0) return
        try {
          const { useEditorStore } = await import('@site/store/store')
          const store = useEditorStore.getState()
          if (ids.length === 1) {
            store.cutNode(ids[0]!)
          } else {
            store.cutNodes([...ids])
          }
        } catch (err) {
          console.error('[spotlight] cutNode failed:', err)
        }
      },
    },

    // ── Paste layer ──────────────────────────────────────────────────────────
    {
      id: 'layers.paste',
      title: 'Paste layer',
      subtitle: 'Paste from the clipboard into the selected layer',
      group: 'editor',
      iconName: 'box-solid',
      keywords: ['layer', 'paste', 'clipboard', 'insert'],
      workspaces: ['site'],
      capability: 'site.structure.edit',
      when: hasSelection,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const nodeId = ctx.editor?.selectedNodeIds[ctx.editor.selectedNodeIds.length - 1]
        if (!nodeId) return
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().pasteNode(nodeId)
        } catch (err) {
          console.error('[spotlight] pasteNode failed:', err)
        }
      },
    },

    // ── Rename layer ─────────────────────────────────────────────────────────
    {
      id: 'layers.rename',
      title: 'Rename layer…',
      subtitle: 'Give the selected layer a custom label',
      group: 'editor',
      iconName: 'edit-solid',
      keywords: ['layer', 'rename', 'label', 'name'],
      workspaces: ['site'],
      capability: 'site.structure.edit',
      when: hasSelection,
      args: [
        {
          id: 'label',
          label: 'Layer label',
          type: 'text',
          placeholder: 'e.g. Hero Section',
          required: true,
        },
      ],
      run: async (ctx) => {
        const label = ctx.args['label']?.trim()
        if (!label) return
        const nodeId = ctx.editor?.selectedNodeIds[ctx.editor.selectedNodeIds.length - 1]
        if (!nodeId) return
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().renameNode(nodeId, label)
        } catch (err) {
          console.error('[spotlight] renameNode failed:', err)
        }
      },
    },

    // ── Lock / Unlock layer ──────────────────────────────────────────────────
    {
      id: 'layers.toggleLock',
      title: 'Toggle layer lock',
      subtitle: 'Lock or unlock the selected layer',
      group: 'editor',
      iconName: 'lock-solid',
      keywords: ['layer', 'lock', 'unlock', 'protect'],
      workspaces: ['site'],
      capability: 'site.structure.edit',
      when: hasSelection,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const nodeId = ctx.editor?.selectedNodeIds[ctx.editor.selectedNodeIds.length - 1]
        if (!nodeId) return
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleNodeLocked(nodeId)
        } catch (err) {
          console.error('[spotlight] toggleNodeLocked failed:', err)
        }
      },
    },

    // ── Hide / Show layer ────────────────────────────────────────────────────
    {
      id: 'layers.toggleVisibility',
      title: 'Toggle layer visibility',
      subtitle: 'Hide or show the selected layer',
      group: 'editor',
      iconName: 'eye-solid',
      keywords: ['layer', 'hide', 'show', 'visibility', 'visible', 'invisible'],
      workspaces: ['site'],
      capability: 'site.structure.edit',
      when: hasSelection,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const nodeId = ctx.editor?.selectedNodeIds[ctx.editor.selectedNodeIds.length - 1]
        if (!nodeId) return
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleNodeHidden(nodeId)
        } catch (err) {
          console.error('[spotlight] toggleNodeHidden failed:', err)
        }
      },
    },

    // ── Wrap in container ────────────────────────────────────────────────────
    {
      id: 'layers.wrapInContainer',
      title: 'Wrap layer in container',
      subtitle: 'Wrap the selected layer in a new container',
      group: 'editor',
      iconName: 'container-solid',
      keywords: ['layer', 'wrap', 'container', 'group', 'nest'],
      workspaces: ['site'],
      capability: 'site.structure.edit',
      when: hasSelection,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const nodeId = ctx.editor?.selectedNodeIds[ctx.editor.selectedNodeIds.length - 1]
        if (!nodeId) return
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().wrapNode(nodeId, 'base.container')
        } catch (err) {
          console.error('[spotlight] wrapNode failed:', err)
        }
      },
    },

    // ── Move up ──────────────────────────────────────────────────────────────
    {
      id: 'layers.moveUp',
      title: 'Move layer up',
      subtitle: 'Move the selected layer one position up',
      group: 'editor',
      iconName: 'arrow-up',
      keywords: ['layer', 'move', 'up', 'reorder', 'position'],
      workspaces: ['site'],
      capability: 'site.structure.edit',
      when: hasSelection,
      run: (ctx) => moveSelectedLayers(ctx, 'up'),
    },

    // ── Move down ────────────────────────────────────────────────────────────
    {
      id: 'layers.moveDown',
      title: 'Move layer down',
      subtitle: 'Move the selected layer one position down',
      group: 'editor',
      iconName: 'arrow-down',
      keywords: ['layer', 'move', 'down', 'reorder', 'position'],
      workspaces: ['site'],
      capability: 'site.structure.edit',
      when: hasSelection,
      run: (ctx) => moveSelectedLayers(ctx, 'down'),
    },

    // ── Select parent ────────────────────────────────────────────────────────
    {
      id: 'layers.selectParent',
      title: 'Select parent layer',
      subtitle: 'Move selection to the parent of the current layer',
      group: 'editor',
      iconName: 'arrow-up',
      keywords: ['layer', 'parent', 'select', 'up', 'navigate'],
      workspaces: ['site'],
      capability: 'site.read',
      when: hasSelection,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const nodeId = ctx.editor?.selectedNodeIds[ctx.editor.selectedNodeIds.length - 1]
        if (!nodeId) return
        try {
          const { store, page } = await getActiveLayerTree()
          if (!page) return
          const parent = getParent(page, nodeId)
          if (!parent) return
          store.selectNode(parent.id)
        } catch (err) {
          console.error('[spotlight] selectParent failed:', err)
        }
      },
    },

    // ── Select first child ───────────────────────────────────────────────────
    {
      id: 'layers.selectFirstChild',
      title: 'Select first child layer',
      subtitle: 'Move selection to the first child of the current layer',
      group: 'editor',
      iconName: 'arrow-down',
      keywords: ['layer', 'child', 'select', 'down', 'navigate', 'first'],
      workspaces: ['site'],
      capability: 'site.read',
      when: hasSelection,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const nodeId = ctx.editor?.selectedNodeIds[ctx.editor.selectedNodeIds.length - 1]
        if (!nodeId) return
        try {
          const { store, page } = await getActiveLayerTree()
          if (!page) return
          const node = page.nodes[nodeId]
          const firstChild = node?.children?.[0]
          if (!firstChild) return
          store.selectNode(firstChild)
        } catch (err) {
          console.error('[spotlight] selectFirstChild failed:', err)
        }
      },
    },
  ]
}
