import { useState } from 'react'
import { Tab, TabList, TabPanel, Tabs } from '@ui/components/Tabs'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { ProfileTab } from './tabs/ProfileTab'
import { SessionsTab } from './tabs/SessionsTab'
import { SecurityTab } from './tabs/SecurityTab'
import { ActivityTab } from './tabs/ActivityTab'
import directory from '@admin/shared/Directory/Directory.module.css'

type AccountTab = 'profile' | 'sessions' | 'security' | 'activity'

const TAB_LABELS: Record<AccountTab, string> = {
  profile: 'Profile',
  sessions: 'Active devices',
  security: 'Security',
  activity: 'Sign-in history',
}

const TAB_ORDER: readonly AccountTab[] = ['profile', 'sessions', 'security', 'activity']

export function AccountPage() {
  const user = useAuthenticatedAdminUser()
  const [tab, setTab] = useState<AccountTab>('profile')

  return (
    <AdminPageLayout workspace="account" mode="workspace">
      <Tabs value={tab} onChange={setTab}>
        <div className={directory.workspace}>
          <TabList ariaLabel="Account sections">
            {TAB_ORDER.map((id) => (
              <Tab key={id} value={id} testId={`account-tab-${id}`}>{TAB_LABELS[id]}</Tab>
            ))}
          </TabList>
          <TabPanel value="profile"><ProfileTab user={user} /></TabPanel>
          <TabPanel value="sessions"><SessionsTab /></TabPanel>
          <TabPanel value="security"><SecurityTab user={user} /></TabPanel>
          <TabPanel value="activity"><ActivityTab /></TabPanel>
        </div>
      </Tabs>
    </AdminPageLayout>
  )
}
