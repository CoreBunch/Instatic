/**
 * Framework commands — quick-jump access to the consolidated Framework panel
 * and the Manage Core Framework dialog.
 *
 * The panel hosts Home / Colors / Typography / Space tabs; these commands open
 * the panel and select a tab, or open the import/remove dialog directly.
 *
 * Capability: `site.style.edit` — the Framework panel manages design tokens,
 * which is a style-edit operation.
 */

import type { Command } from '../types'

const FRAMEWORK_CAPABILITY = 'site.style.edit'

// Local mirror of the Framework panel's tab union — spotlight commands must not
// import editor-store internals (slices/types). Gated by
// spotlight-no-direct-store-mutation.test.ts.
type FrameworkPanelTab = 'home' | 'colors' | 'typography' | 'spacing'

/** Open the Framework panel and switch it to the given tab. */
async function openFrameworkTab(tab: FrameworkPanelTab): Promise<void> {
  const { useEditorStore } = await import('@site/store/store')
  const state = useEditorStore.getState()
  state.setLeftSidebarPanel('framework')
  state.setFrameworkPanelTab(tab)
}

export function getFrameworkCommands(): Command[] {
  return [
    {
      id: 'framework.open',
      title: 'Open Framework panel',
      subtitle: 'Design tokens overview — colors, typography, spacing',
      group: 'framework',
      iconName: 'colors-swatch-solid',
      keywords: ['framework', 'design', 'tokens', 'overview', 'home', 'open'],
      workspaces: ['site'],
      capability: FRAMEWORK_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          await openFrameworkTab('home')
        } catch (err) {
          console.error('[spotlight] openFramework failed:', err)
        }
      },
    },

    {
      id: 'framework.openColors',
      title: 'Open Colors',
      subtitle: 'Browse and manage color design tokens',
      group: 'framework',
      iconName: 'colors-swatch-solid',
      keywords: ['colors', 'tokens', 'palette', 'design', 'framework', 'open'],
      workspaces: ['site'],
      capability: FRAMEWORK_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          await openFrameworkTab('colors')
        } catch (err) {
          console.error('[spotlight] openColors failed:', err)
        }
      },
    },

    {
      id: 'framework.openTypography',
      title: 'Open Typography',
      subtitle: 'Browse and manage typography design tokens',
      group: 'framework',
      iconName: 'braces',
      keywords: ['typography', 'fonts', 'type', 'tokens', 'design', 'framework', 'open'],
      workspaces: ['site'],
      capability: FRAMEWORK_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          await openFrameworkTab('typography')
        } catch (err) {
          console.error('[spotlight] openTypography failed:', err)
        }
      },
    },

    {
      id: 'framework.openSpacing',
      title: 'Open Spacing',
      subtitle: 'Browse and manage spacing design tokens',
      group: 'framework',
      iconName: 'proportions-solid',
      keywords: ['spacing', 'gaps', 'padding', 'margin', 'tokens', 'design', 'framework', 'open'],
      workspaces: ['site'],
      capability: FRAMEWORK_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          await openFrameworkTab('spacing')
        } catch (err) {
          console.error('[spotlight] openSpacing failed:', err)
        }
      },
    },

    {
      id: 'framework.manage',
      title: 'Manage Core Framework',
      subtitle: 'Import, re-import, or remove the Core Framework preset',
      group: 'framework',
      iconName: 'sliders-horizontal',
      keywords: ['framework', 'core', 'import', 'remove', 'prune', 'manage', 'preset', 'tokens'],
      workspaces: ['site'],
      capability: FRAMEWORK_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          const state = useEditorStore.getState()
          state.setLeftSidebarPanel('framework')
          state.setFrameworkManagerOpen(true)
        } catch (err) {
          console.error('[spotlight] manageFramework failed:', err)
        }
      },
    },
  ]
}
