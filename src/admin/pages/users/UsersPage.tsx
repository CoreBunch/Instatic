/**
 * UsersPage — `/admin/users`.
 *
 * Capability-gated workspace for managing CMS users, custom roles and the
 * audit log. The page itself is a thin shell: it figures out which tabs
 * the current admin is allowed to see (`users.manage`, `roles.manage`,
 * `audit.read`), loads the underlying data once via `useUsersPageData`,
 * and delegates rendering to the per-tab components in `./tabs/`.
 *
 * Each tab owns its own form state, busy flag, and dialog open/close
 * state — only the loaded data, the shared error string, and the
 * mutation refresh callback live here.
 */
import { useEffect, useEffectEvent, useState } from 'react'
import { peekPendingAction } from '@admin/spotlight/pendingAction'
import { Tab, TabList, TabPanel, Tabs } from '@ui/components/Tabs'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { AuditTab } from './tabs/AuditTab'
import { RolesTab } from './tabs/RolesTab'
import { UsersTab } from './tabs/UsersTab'
import { useUsersPageData } from './hooks/useUsersPageData'
import { tabLabel } from './utils/format'
import type { Tab as UsersPageTab, UsersPageLoadAccess } from './types'
import styles from './UsersPage.module.css'

export function UsersPage() {
  const currentUser = useCurrentAdminUser()
  const unrestricted = !currentUser
  const canManageUsers = unrestricted || hasCapability(currentUser, 'users.manage')
  const canManageRoles = unrestricted || hasCapability(currentUser, 'roles.manage')
  const canReadAudit = unrestricted || hasCapability(currentUser, 'audit.read')
  const canReadRoleOptions = canManageUsers || canManageRoles

  const loadAccess: UsersPageLoadAccess = { canManageUsers, canReadRoleOptions, canReadAudit }
  const data = useUsersPageData(loadAccess)

  const availableTabs: UsersPageTab[] = []
  if (canManageUsers) availableTabs.push('users')
  if (canManageRoles) availableTabs.push('roles')
  if (canReadAudit) availableTabs.push('audit')

  const [tab, setTab] = useState<UsersPageTab>('users')
  const activeTab = availableTabs.includes(tab) ? tab : availableTabs[0] ?? 'users'

  // Cross-workspace spotlight actions can target this page. Peek (don't
  // consume) at the pending action so the appropriate tab is selected before
  // the tab itself mounts and consumes the action. Microtask defer to keep
  // the setState off the commit phase without risking the macrotask race
  // that setTimeout(0) would expose to fast cross-page navigations.
  //
  // useEffectEvent reads the latest availableTabs at mount-fire time without
  // making the effect dependent on it (rebinding tabs while the page is
  // already mounted shouldn't re-trigger the pending-action routing).
  const consumePendingTabSelection = useEffectEvent(() => {
    const newRolePending =
      peekPendingAction('users.newRole') && availableTabs.includes('roles')
    const invitePending =
      peekPendingAction('users.invite') && availableTabs.includes('users')
    if (!newRolePending && !invitePending) return
    queueMicrotask(() => {
      if (newRolePending) setTab('roles')
      else if (invitePending) setTab('users')
    })
  })
  useEffect(() => {
    consumePendingTabSelection()
  }, [])

  const tabs = (
    <TabList ariaLabel="Users sections">
      {availableTabs.map((item) => (
        <Tab key={item} value={item}>
          <span>{tabLabel(item)}</span>
        </Tab>
      ))}
    </TabList>
  )

  return (
    <Tabs value={activeTab} onChange={setTab}>
      <AdminPageLayout
        workspace="users"
        title="Users"
        titleId="users-title"
        description="Manage admin access, custom roles, and security audit events."
        tabs={tabs}
      >
        {/* No `loading` on the layout — the tabs below own their own
            skeleton states, each matching their real (DataTable) layout
            1:1 so the column ladder stays put when the data arrives. */}
        <div className={styles.body}>
          {data.error && <p className={styles.error} role="alert">{data.error}</p>}

          <TabPanel value="users"><UsersTab data={data} canManageUsers={canManageUsers} /></TabPanel>
          <TabPanel value="roles"><RolesTab data={data} canManageRoles={canManageRoles} /></TabPanel>
          <TabPanel value="audit"><AuditTab data={data} /></TabPanel>
        </div>
      </AdminPageLayout>
    </Tabs>
  )
}
