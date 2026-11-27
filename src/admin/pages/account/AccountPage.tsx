import { useState } from 'react'
import { Tab, TabList, TabPanel, Tabs } from '@ui/components/Tabs'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import styles from './AccountPage.module.css'
import { SessionsTab } from './tabs/SessionsTab'
import { OverviewTab } from './tabs/OverviewTab'
import { ActivityTab } from './tabs/ActivityTab'

type AccountTab = 'overview' | 'sessions' | 'activity'

const TAB_LABELS: Record<AccountTab, string> = {
  overview: 'Overview',
  sessions: 'Active devices',
  activity: 'Sign-in history',
}

const TAB_ORDER: readonly AccountTab[] = ['overview', 'sessions', 'activity']

export function AccountPage() {
  const user = useAuthenticatedAdminUser()
  const [tab, setTab] = useState<AccountTab>('overview')

  return (
    <AdminPageLayout workspace="account" mode="workspace">
      <Tabs value={tab} onChange={setTab}>
        <div className={styles.workspace}>
          <h1 className={styles.workspaceTitle}>Account</h1>
          <TabList ariaLabel="Account sections">
            {TAB_ORDER.map((id) => (
              <Tab key={id} value={id} testId={`account-tab-${id}`}>{TAB_LABELS[id]}</Tab>
            ))}
          </TabList>
          <TabPanel value="overview"><OverviewTab user={user} /></TabPanel>
          <TabPanel value="sessions"><SessionsTab /></TabPanel>
          <TabPanel value="activity"><ActivityTab /></TabPanel>
        </div>
      </Tabs>
    </AdminPageLayout>
  )
}
