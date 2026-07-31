/**
 * AccountPage — `/admin/account`.
 *
 * Self-targeted user settings page. Every authenticated user sees the same
 * shell (no capability gating — see `canAccessWorkspace('account', user)`).
 * Layout mirrors `UsersPage` for visual consistency: a header, a tab nav,
 * and a section body that swaps based on the active tab.
 *
 * Four tabs:
 *   - Profile        — display name + email + role + avatar slot
 *   - Active devices — live session list + per-row sign-out + "sign out
 *                       everywhere else"
 *   - Security       — password / MFA / recovery / connected sign-ins
 *                       (placeholder shell with disabled CTAs until C.4)
 *   - Sign-in history — login_attempts audit feed scoped to the current user
 *                       (successes AND failures, with a failed-attempt count
 *                       and suspicious-activity banner)
 *
 * "Active devices" answers "who is signed in right now and how do I kick
 * them out?"; "Sign-in history" answers "has anyone been trying to break
 * into my account?". The two tabs intentionally don't overlap — sessions
 * are mutable live state, history is an append-only audit trail that
 * includes attempts which never produced a session at all.
 *
 * Why a route, not a modal? The toolbar avatar dropdown stays the primary
 * entry point but Active devices + Sign-in history are both list-heavy and
 * benefit from a full canvas. A modal would also collide with the editor's
 * overlay panels (DOM tree, properties) on the Site workspace.
 */
import { useState } from 'react'
import { Tab, TabList, TabPanel, Tabs } from '@ui/components/Tabs'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { ProfileTab } from './tabs/ProfileTab'
import { SessionsTab } from './tabs/SessionsTab'
import { SecurityTab } from './tabs/SecurityTab'
import { ActivityTab } from './tabs/ActivityTab'
import styles from './AccountPage.module.css'

type AccountTab = 'profile' | 'sessions' | 'security' | 'activity'

const TAB_LABELS: Record<AccountTab, string> = {
  profile: 'Profile',
  sessions: 'Active devices',
  security: 'Security',
  activity: 'Sign-in history',
}

const TAB_ORDER: readonly AccountTab[] = ['profile', 'sessions', 'security', 'activity']

export function AccountPage() {
  // The page renders inside the authenticated branch of `AdminEntry` — by
  // the time we get here, a session user is guaranteed. The strict variant
  // throws if that contract is violated, so the rest of the component can
  // hand a non-nullable `user` down to its tabs without a "what if it's
  // null" fallback.
  const user = useAuthenticatedAdminUser()
  const [tab, setTab] = useState<AccountTab>('profile')

  const tabs = (
    <TabList ariaLabel="Account sections">
      {TAB_ORDER.map((id) => (
        <Tab key={id} value={id} testId={`account-tab-${id}`}>
          <span>{TAB_LABELS[id]}</span>
        </Tab>
      ))}
    </TabList>
  )

  return (
    <Tabs value={tab} onChange={setTab}>
      <AdminPageLayout
        workspace="account"
        title="Account"
        titleId="account-title"
        description="Manage your profile, devices, security, and sign-in activity."
        tabs={tabs}
      >
        <div className={styles.body}>
          <TabPanel value="profile"><ProfileTab user={user} /></TabPanel>
          <TabPanel value="sessions"><SessionsTab /></TabPanel>
          <TabPanel value="security"><SecurityTab user={user} /></TabPanel>
          <TabPanel value="activity"><ActivityTab /></TabPanel>
        </div>
      </AdminPageLayout>
    </Tabs>
  )
}
