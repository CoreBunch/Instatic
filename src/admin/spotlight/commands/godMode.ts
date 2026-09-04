/**
 * God Mode commands — toggle the Code Dock editing mode.
 *
 * Capability: `site.structure.edit` — God Mode's HTML panel bypasses
 * per-module guardrails, so only structure editors may enter it. The
 * `when()` predicate additionally requires the `godMode` editor preference:
 * the Settings toggle is what unlocks the mode (see
 * docs/features/god-mode.md), and the palette should not advertise a
 * command that would no-op.
 */

import { isGodModeUnlocked } from '@site/hooks/useGodModeUnlocked'
import type { Command } from '../types'

export function getGodModeCommands(): Command[] {
  return [
    {
      id: 'godMode.toggle',
      title: 'Toggle God Mode',
      subtitle: 'Swap the properties sidebar for the HTML | CSS | JS Code Dock',
      group: 'editor',
      iconName: 'code',
      keywords: ['god', 'mode', 'code', 'dock', 'html', 'css', 'js', 'panels'],
      workspaces: ['site'],
      capability: 'site.structure.edit',
      when: (ctx) => isGodModeUnlocked(ctx.user),
      run: async (ctx) => {
        ctx.closeSpotlight()
        if (!isGodModeUnlocked(ctx.user)) return
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleGodMode()
        } catch (err) {
          console.error('[spotlight] toggle god mode failed:', err)
        }
      },
    },
  ]
}
