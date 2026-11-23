/**
 * EmailPage — `/admin/email`.
 *
 * The workspace for the site's outgoing mail, with four sections: connectors (the accounts mail is sent through), defaults (which
 * connector, and the sender), templates (the wording of each email) and
 * activity (the delivery log). Gated by `mail.manage`.
 */
import { useState } from 'react'
import { Tab, TabList, TabPanel, Tabs } from '@ui/components/Tabs'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { getCmsMailOverview } from '@core/persistence'
import directory from '@admin/shared/Directory/Directory.module.css'
import { ConnectorsTab } from './tabs/ConnectorsTab'
import { DefaultsTab } from './tabs/DefaultsTab'
import { TemplatesTab } from './tabs/TemplatesTab'
import { ActivityTab } from './tabs/ActivityTab'

const SECTIONS = ['connectors', 'defaults', 'templates', 'activity'] as const
type Section = (typeof SECTIONS)[number]

const SECTION_LABELS: Record<Section, string> = {
  connectors: 'Connectors',
  defaults: 'Defaults',
  templates: 'Templates',
  activity: 'Activity',
}

export function EmailPage() {
  const [section, setSection] = useState<Section>('connectors')
  // Set when Activity opens a template, so the Templates tab lands on it.
  const [templateKey, setTemplateKey] = useState<string | null>(null)
  // Connectors and Defaults both read the same overview; load it once here
  // so moving between them is instant and they never disagree.
  const overview = useAsyncResource((signal) => getCmsMailOverview(signal), [], {
    fallbackError: 'Could not load the email settings.',
  })

  return (
    <AdminPageLayout workspace="email" mode="workspace">
      <Tabs value={section} onChange={setSection}>
        <div className={directory.workspace}>
          <TabList ariaLabel="Email settings">
            {SECTIONS.map((item) => (
              <Tab key={item} value={item} testId={`email-nav-${item}`}>{SECTION_LABELS[item]}</Tab>
            ))}
          </TabList>
          <TabPanel value="connectors">
            <ConnectorsTab
              overview={overview.data}
              loading={overview.loading}
              error={overview.error}
              onChanged={overview.refresh}
              onNavigateToDefaults={() => setSection('defaults')}
            />
          </TabPanel>
          <TabPanel value="defaults">
            <DefaultsTab
              overview={overview.data}
              error={overview.error}
              onChanged={overview.refresh}
              onNavigateToConnectors={() => setSection('connectors')}
            />
          </TabPanel>
          <TabPanel value="templates"><TemplatesTab initialKey={templateKey} /></TabPanel>
          <TabPanel value="activity">
            <ActivityTab
              capturing={overview.data?.mode === 'capture'}
              onOpenConnectors={() => setSection('connectors')}
              onOpenTemplate={(key) => {
                setTemplateKey(key)
                setSection('templates')
              }}
            />
          </TabPanel>
        </div>
      </Tabs>
    </AdminPageLayout>
  )
}
