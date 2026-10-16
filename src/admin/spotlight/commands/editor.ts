/**
 * Editor commands — Publish, Undo, Redo.
 * §4.2 of the Command Spotlight master plan.
 *
 * All commands are gated to workspace: ['site'] only. There is no Save
 * command: the collab relay persists continuously, so there is nothing to
 * flush from a keystroke.
 * Undo/redo use useEditorStore.getState() (Zustand getState is safe outside React).
 * Publish calls publishCmsDraft() from the persistence layer, wrapped in
 * `ctx.runStepUp` so the StepUpProvider's password re-entry dialog opens
 * when the server replies with `step_up_required` (publish is gated on a
 * fresh step-up window on top of `pages.publish`).
 */

import { StepUpCancelledMessage } from '@admin/shared/StepUp'
import { publishCmsDraft } from '@core/persistence'
import { isOnMainBranch } from '@admin/state/branchStore'
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
      id: 'editor.publish',
      title: 'Publish',
      subtitle: 'Publish the current draft to production',
      group: 'editor',
      iconName: 'send-solid',
      keywords: ['publish', 'deploy', 'live', 'production'],
      workspaces: ['site'],
      capability: 'pages.publish',
      // Publishing only exists on main; on a branch the palette hides it.
      // A visibility gate, not a relevance one: `when` would hand Publish a
      // standing +250 on main and pin it above recently run commands.
      available: () => isOnMainBranch(),
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
