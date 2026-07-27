/**
 * MembersPage — `/admin/members`.
 *
 * Capability-gated workspace for managing registered visitor accounts
 * (members) and visitor roles. Mirrors `pages/users/UsersPage.tsx`: a thin
 * shell that checks the `users.manage` capability (the same capability the
 * server-side `/admin/api/cms/visitor-auth/*` routes require), renders a
 * tab row ("Visitors" | "Roles"), loads visitors + roles via
 * {@link useMembersData}, and delegates the body to {@link VisitorsTable}
 * or {@link RolesTab}.
 *
 * The capability gate is defensive — `AuthenticatedAdmin` already redirects
 * users who lack access to their first accessible workspace. Mirroring
 * `UsersPage`, we render an explicit access-denied block here too so a
 * direct deep link never lands on an empty table.
 */
import { useState } from 'react'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { Tabs, TabList, Tab } from '@ui/components/Tabs'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { useMembersData } from './hooks/useMembersData'
import { VisitorsTable } from './components/VisitorsTable'
import { GroupsTab } from './components/GroupsTab'
import { RolesTab } from './components/RolesTab'
import type { MembersTab } from './types'
import styles from './MembersPage.module.css'

export function MembersPage() {
  const currentUser = useCurrentAdminUser()
  // `currentUser === null` only happens outside AdminSessionProvider (layout
  // tests / SSR preview). Treat it as unrestricted there; the browser
  // session always carries a user.
  const canManage = !currentUser || hasCapability(currentUser, 'users.manage')
  const data = useMembersData()
  const [tab, setTab] = useState<MembersTab>('visitors')

  const tabs = (
    <TabList ariaLabel="Members sections">
      <Tab value="visitors">Visitors</Tab>
      <Tab value="groups">Groups</Tab>
      <Tab value="roles">Roles</Tab>
    </TabList>
  )

  return (
    <Tabs value={tab} onChange={setTab}>
      <AdminPageLayout
        workspace="members"
        title="Members"
        titleId="members-title"
        description="Manage visitor accounts, roles, and access."
        tabs={tabs}
      >
        {!canManage ? (
          <p className={styles.error} role="alert">
            Your role does not include the Users manage permission required to manage visitor accounts.
          </p>
        ) : (
          <div className={styles.body}>
            {data.error && <p className={styles.error} role="alert">{data.error}</p>}
            {tab === 'visitors' && <VisitorsTable data={data} />}
            {tab === 'groups' && <GroupsTab data={data} />}
            {tab === 'roles' && <RolesTab data={data} />}
          </div>
        )}
      </AdminPageLayout>
    </Tabs>
  )
}
