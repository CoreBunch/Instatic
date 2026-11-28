/**
 * Users / Roles / Audit commands — §4.12 of the Command Spotlight master plan.
 */

import type { Command } from '../types'
import { queuePendingAction } from '../pendingAction'

export function getUsersCommands(): Command[] {
  return [
    // ── Invite user ─────────────────────────────────────────────────────────
    {
      id: 'users.invite',
      title: 'Invite user…',
      subtitle: 'Create a new admin user and send an invite',
      group: 'users',
      iconName: 'plus',
      keywords: ['user', 'invite', 'team', 'member', 'new', 'create', 'add', 'account'],
      workspaces: ['any'],
      capability: 'users.manage',
      run: (ctx) => {
        ctx.navigate('/admin/users?invite')
      },
    },

    // ── New role ─────────────────────────────────────────────────────────────
    {
      id: 'users.newRole',
      title: 'New role…',
      subtitle: 'Define a new role with custom capabilities',
      group: 'users',
      iconName: 'cursor-minimal-solid',
      keywords: ['user', 'role', 'permissions', 'capabilities', 'new', 'create', 'add'],
      workspaces: ['any'],
      capability: 'roles.manage',
      run: (ctx) => {
        queuePendingAction('users.newRole')
        ctx.navigate('/admin/users')
      },
    },
  ]
}
