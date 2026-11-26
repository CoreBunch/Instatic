/**
 * Preview commands — §4.2 (canvas mode / preview) of the master plan.
 *
 * Toggle preview overlay, toggle the Hand tool, control zoom.
 * All gated to workspace: ['site'] and capability `site.read` — these are
 * pure viewing affordances against the canvas.
 */

import type { Command } from '../types'

const PREVIEW_CAPABILITY = 'site.read'

export function getPreviewCommands(): Command[] {
  return [
    // ── Toggle preview ───────────────────────────────────────────────────────
    {
      id: 'preview.toggle',
      title: 'Toggle preview',
      subtitle: 'Switch between edit and preview mode',
      group: 'preview',
      iconName: 'eye-solid',
      keywords: ['preview', 'toggle', 'view', 'live', 'read-only'],
      workspaces: ['site'],
      capability: PREVIEW_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          const store = useEditorStore.getState()
          if (store.previewOpen) {
            store.closePreview()
          } else {
            store.openPreview()
          }
        } catch (err) {
          console.error('[spotlight] togglePreview failed:', err)
        }
      },
    },

    // ── Hand tool ────────────────────────────────────────────────────────────
    {
      id: 'preview.toggleHandTool',
      title: 'Toggle Hand tool',
      subtitle: 'Drag to pan the design canvas instead of selecting',
      group: 'preview',
      iconName: 'hand-grab-solid',
      keywords: ['hand', 'pan', 'drag', 'move', 'canvas', 'scroll', 'tool', 'pen', 'tablet', 'select'],
      workspaces: ['site'],
      capability: PREVIEW_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleHandTool()
        } catch (err) {
          console.error('[spotlight] toggleHandTool failed:', err)
        }
      },
    },

    // ── Zoom in ──────────────────────────────────────────────────────────────
    {
      id: 'preview.zoomIn',
      title: 'Zoom in',
      subtitle: 'Increase canvas zoom level',
      group: 'preview',
      iconName: 'plus',
      keywords: ['zoom', 'in', 'enlarge', 'magnify', 'canvas'],
      workspaces: ['site'],
      capability: PREVIEW_CAPABILITY,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().zoomIn()
        } catch (err) {
          console.error('[spotlight] zoomIn failed:', err)
        }
      },
    },

    // ── Zoom out ─────────────────────────────────────────────────────────────
    {
      id: 'preview.zoomOut',
      title: 'Zoom out',
      subtitle: 'Decrease canvas zoom level',
      group: 'preview',
      iconName: 'proportions-solid',
      keywords: ['zoom', 'out', 'shrink', 'canvas'],
      workspaces: ['site'],
      capability: PREVIEW_CAPABILITY,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().zoomOut()
        } catch (err) {
          console.error('[spotlight] zoomOut failed:', err)
        }
      },
    },

    // ── Reset zoom ───────────────────────────────────────────────────────────
    {
      id: 'preview.zoomReset',
      title: 'Reset zoom to 100%',
      subtitle: 'Reset the canvas to 1:1 zoom',
      group: 'preview',
      iconName: 'laptop-solid',
      keywords: ['zoom', 'reset', '100%', 'actual size', 'canvas'],
      workspaces: ['site'],
      capability: PREVIEW_CAPABILITY,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().setZoom(1)
        } catch (err) {
          console.error('[spotlight] setZoom reset failed:', err)
        }
      },
    },
  ]
}
