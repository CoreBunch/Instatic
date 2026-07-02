/**
 * Editor commands — Save, Publish, Undo, Redo.
 * §4.2 of the Command Spotlight master plan.
 *
 * All commands are gated to workspace: ['site'] only.
 * Undo/redo use useEditorStore.getState() (Zustand getState is safe outside React).
 * Save flushes through `usePersistence`'s registered save (editorSaveRef) so
 * it rides the single-flight queue, the dirty-mark snapshot, and the
 * conflict-detection base seqs — a raw adapter call here would bulldoze all
 * three and ship a replace-mode full save.
 * Publish calls publishCmsDraft() from the persistence layer, wrapped in
 * `ctx.runStepUp` so the StepUpProvider's password re-entry dialog opens
 * when the server replies with `step_up_required` (publish is gated on a
 * fresh step-up window on top of `pages.publish`).
 */

import { StepUpCancelledMessage } from '@admin/shared/StepUp'
import { publishCmsDraft } from '@core/persistence'
import type { Command } from '../types'

/** Mirrors `SITE_WRITE_CAPABILITIES` — any holder can save a draft. */
const SITE_WRITE_CAPABILITIES = [
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
] as const

export function getEditorCommands(): Command[] {
  return [
    {
      id: 'editor.save',
      title: 'Save',
      subtitle: 'Save the current draft',
      group: 'editor',
      iconName: 'save-solid',
      keywords: ['save', 'draft', 'write'],
      workspaces: ['site'],
      capability: SITE_WRITE_CAPABILITIES,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          // Import lazily to avoid loading editor code in non-site contexts.
          // No-op when the editor isn't mounted (the command is site-only).
          const { flushEditorSave } = await import('@site/hooks/editorSaveRef')
          await flushEditorSave()
        } catch (err) {
          console.error('[spotlight] save failed:', err)
        }
      },
    },
    {
      id: 'editor.publish',
      title: 'Publish',
      subtitle: 'Publish the current draft to production',
      group: 'editor',
      iconName: 'send-solid',
      keywords: ['publish', 'deploy', 'live', 'production'],
      workspaces: ['site'],
      capability: 'pages.publish',
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          await ctx.runStepUp(() => publishCmsDraft())
        } catch (err) {
          if (err instanceof Error && err.message === StepUpCancelledMessage) return
          console.error('[spotlight] publish failed:', err)
        }
      },
    },
    {
      id: 'editor.undo',
      title: 'Undo',
      subtitle: 'Undo the last change',
      group: 'editor',
      iconName: 'undo',
      keywords: ['undo', 'revert', 'back'],
      workspaces: ['site'],
      capability: SITE_WRITE_CAPABILITIES,
      when: (ctx) => ctx.editor?.canUndo === true,
      priorityBoost: 1.2,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const { useEditorStore } = await import('@site/store/store')
        useEditorStore.getState().undo()
      },
    },
    {
      id: 'editor.redo',
      title: 'Redo',
      subtitle: 'Redo the last undone change',
      group: 'editor',
      iconName: 'redo',
      keywords: ['redo', 'forward'],
      workspaces: ['site'],
      capability: SITE_WRITE_CAPABILITIES,
      when: (ctx) => ctx.editor?.canRedo === true,
      priorityBoost: 1.2,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const { useEditorStore } = await import('@site/store/store')
        useEditorStore.getState().redo()
      },
    },
  ]
}
