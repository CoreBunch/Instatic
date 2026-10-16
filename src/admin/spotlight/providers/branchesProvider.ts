/**
 * Branches provider — "Switch to <branch>" rows for branch names typed in
 * the root palette. LOCAL: reads the branch store synchronously (the toolbar
 * chip keeps the registry fresh), no HTTP, no debounce.
 */
import { switchBranch, useBranchStore } from '@admin/state/branchStore'
import type { Command, SpotlightProvider } from '../types'

const MAX_RESULTS = 25

export const branchesProvider: SpotlightProvider = {
  id: 'branches',
  label: 'Branches',
  debounceMs: 0,

  search(query, _ctx, signal): Command[] {
    if (signal.aborted) return []
    const q = query.trim().toLowerCase()
    if (!q) return []
    const { branches, activeBranchId } = useBranchStore.getState()
    return branches
      .filter((branch) => branch.id !== activeBranchId)
      .filter((branch) => branch.name.toLowerCase().includes(q) || branch.id.includes(q))
      .slice(0, MAX_RESULTS)
      .map((branch): Command => ({
        id: `branch:${branch.id}`,
        title: `Switch to ${branch.name}`,
        subtitle: branch.baseBranchId ? `Branch from ${branch.baseBranchId}` : 'The live site',
        group: 'branches',
        iconName: branch.baseBranchId ? 'git-branch-solid' : 'circle-dot-solid',
        keywords: ['branch', 'switch', branch.id],
        workspaces: ['any'],
        capability: 'site.read',
        run: (ctx) => {
          ctx.closeSpotlight()
          switchBranch(branch.id)
        },
      }))
  },
}
