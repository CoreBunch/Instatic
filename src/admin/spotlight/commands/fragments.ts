/**
 * Insert fragment command — open the Insert fragment dialog, which inserts a
 * section, page or component exported as a fragment package (`@core/fragments`).
 *
 * Site editor only: a fragment lands in the open document. Capability gate
 * mirrors editor.save: any user who holds at least one site-write capability.
 */

import type { Command } from '../types'
import { SITE_WRITE_CAPABILITIES } from './editor'

export function getFragmentsCommands(): Command[] {
  return [
    {
      id: 'editor.insertFragment',
      title: 'Insert fragment from file…',
      subtitle: 'Insert a section, page or component with its styles, tokens and media',
      group: 'editor',
      iconName: 'layout-solid',
      keywords: ['fragment', 'insert', 'section', 'import', 'package', 'zip', 'template'],
      workspaces: ['site'],
      capability: SITE_WRITE_CAPABILITIES,
      run: async (ctx) => {
        ctx.closeSpotlight()
        // Lazy import keeps the editor store out of non-site bundles.
        const { useEditorStore } = await import('@site/store/store')
        useEditorStore.getState().openInsertFragmentModal()
      },
    },
  ]
}
