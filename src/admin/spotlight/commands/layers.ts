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
import type { Command } from '../types'

const hasSelection = (ctx: { editor?: { selectedNodeIds: ReadonlyArray<string> } }) =>
  (ctx.editor?.selectedNodeIds.length ?? 0) > 0

async function getActiveLayerTree() {
  const { useEditorStore, selectActiveCanvasPage } = await import('@site/store/store')
  const store = useEditorStore.getState()
  return { store, page: selectActiveCanvasPage(store) }
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
        const nodeId = ctx.editor?.selectedNodeIds[ctx.editor.selectedNodeIds.length - 1]
        if (!nodeId) return
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().duplicateNode(nodeId)
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
      run: async (ctx) => {
        ctx.closeSpotlight()
        const nodeId = ctx.editor?.selectedNodeIds[ctx.editor.selectedNodeIds.length - 1]
        if (!nodeId) return
        try {
          const { store, page } = await getActiveLayerTree()
          if (!page) return
          const parent = getParent(page, nodeId)
          if (!parent) return
          const siblings = parent.children ?? []
          const idx = siblings.indexOf(nodeId)
          if (idx <= 0) return
          store.moveNode(nodeId, parent.id, idx - 1)
        } catch (err) {
          console.error('[spotlight] moveNode up failed:', err)
        }
      },
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
      run: async (ctx) => {
        ctx.closeSpotlight()
        const nodeId = ctx.editor?.selectedNodeIds[ctx.editor.selectedNodeIds.length - 1]
        if (!nodeId) return
        try {
          const { store, page } = await getActiveLayerTree()
          if (!page) return
          const parent = getParent(page, nodeId)
          if (!parent) return
          const siblings = parent.children ?? []
          const idx = siblings.indexOf(nodeId)
          if (idx < 0 || idx >= siblings.length - 1) return
          store.moveNode(nodeId, parent.id, idx + 1)
        } catch (err) {
          console.error('[spotlight] moveNode down failed:', err)
        }
      },
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
