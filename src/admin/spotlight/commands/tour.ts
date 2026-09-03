/**
 * Tour commands — replay the Site editor's guided onboarding tour.
 *
 * - Take the editor tour → available everywhere. When the user is already
 *   on the site workspace, `startEditorTour()` runs directly. When they're
 *   on a different workspace (Content, Account, …) we queue a pending
 *   action and navigate — SitePage's pending-action consumer starts the
 *   tour on mount once the site has loaded.
 */

import type { Command } from '../types'
import { queuePendingAction } from '../pendingAction'

export function getTourCommands(): Command[] {
  return [
    // ── Take the editor tour ─────────────────────────────────────────────────
    {
      id: 'help.editorTour',
      title: 'Take the editor tour',
      subtitle: 'Replay the guided tour of the site editor',
      group: 'help',
      iconName: 'sparkles-solid',
      keywords: ['tour', 'help', 'onboarding', 'guide', 'walkthrough', 'editor'],
      workspaces: ['any'],
      capability: 'site.read',
      run: async (ctx) => {
        if (ctx.workspace === 'site') {
          try {
            const { startEditorTour } = await import('@site/tour/useEditorTour')
            startEditorTour()
            return
          } catch (err) {
            console.error('[spotlight] startEditorTour failed:', err)
          }
        }

        // Cross-workspace: queue + navigate. SitePage executes on mount.
        queuePendingAction('site.startTour')
        ctx.navigate('/admin/site')
      },
    },
  ]
}
