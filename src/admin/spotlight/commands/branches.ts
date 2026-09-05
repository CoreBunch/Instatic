/**
 * Branch commands — switch, create, manage. Available on every workspace:
 * the active branch is a property of the tab, not of a section.
 *
 * Switching to a specific branch by name is a provider (`branchesProvider`)
 * so typing a branch name in the root palette finds it directly.
 */
import { MAIN_BRANCH_ID } from '@core/branches'
import { isOnMainBranch, switchBranch, useBranchStore } from '@admin/state/branchStore'
import type { Command } from '../types'

export function getBranchesCommands(): Command[] {
  return [
    {
      id: 'branches.switch',
      title: 'Switch branch…',
      subtitle: 'Open the branch switcher',
      group: 'branches',
      iconName: 'git-branch-solid',
      keywords: ['branch', 'switch', 'checkout', 'workspace'],
      workspaces: ['any'],
      capability: 'site.read',
      run: (ctx) => {
        ctx.closeSpotlight()
        useBranchStore.getState().openSwitcher('list')
      },
    },
    {
      id: 'branches.create',
      title: 'Create branch…',
      subtitle: 'Fork the current branch into a private copy',
      group: 'branches',
      iconName: 'git-branch-solid',
      keywords: ['branch', 'create', 'new', 'fork'],
      workspaces: ['any'],
      capability: 'site.branches.manage',
      run: (ctx) => {
        ctx.closeSpotlight()
        useBranchStore.getState().openSwitcher('create')
      },
    },
    {
      id: 'branches.switchMain',
      title: 'Switch to main',
      subtitle: 'Back to the live site',
      group: 'branches',
      iconName: 'circle-dot-solid',
      keywords: ['branch', 'main', 'live', 'switch'],
      workspaces: ['any'],
      capability: 'site.read',
      available: () => !isOnMainBranch(),
      run: (ctx) => {
        ctx.closeSpotlight()
        switchBranch(MAIN_BRANCH_ID)
      },
    },
    {
      id: 'branches.manage',
      title: 'Manage branches…',
      subtitle: 'Rename or delete branches',
      group: 'branches',
      iconName: 'edit-solid',
      keywords: ['branch', 'manage', 'rename', 'delete'],
      workspaces: ['any'],
      capability: 'site.branches.manage',
      run: (ctx) => {
        ctx.closeSpotlight()
        useBranchStore.getState().openManage()
      },
    },
  ]
}
