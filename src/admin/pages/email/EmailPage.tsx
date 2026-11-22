/**
 * EmailPage — `/admin/email`.
 *
 * The workspace for the site's outgoing mail, laid out like the AI
 * workspace: connectors (the accounts mail is sent through), defaults (which
 * connector, and the sender), templates (the wording of each email) and
 * activity (the delivery log). Gated by `mail.manage`.
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { getCmsMailOverview } from '@core/persistence'
import { PlugSolidIcon } from 'pixel-art-icons/icons/plug-solid'
import { Settings2SolidIcon } from 'pixel-art-icons/icons/settings-2-solid'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { ChartSolidIcon } from 'pixel-art-icons/icons/chart-solid'
import ws from '@admin/shared/SettingsWorkspace/SettingsWorkspace.module.css'
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

const SECTION_ICONS = {
  connectors: PlugSolidIcon,
  defaults: Settings2SolidIcon,
  templates: FileTextSolidIcon,
  activity: ChartSolidIcon,
} satisfies Record<Section, typeof PlugSolidIcon>

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
      <div className={ws.workspace}>
        <aside className={ws.workspaceSidebar} aria-label="Email workspace">
          <div className={ws.workspaceIdentity}>
            <h1 id="email-title">Email</h1>
            <p>Connectors, the sender, templates, and delivery.</p>
          </div>

          <nav className={ws.workspaceNavigation} aria-label="Email settings">
            {SECTIONS.map((item) => {
              const Icon = SECTION_ICONS[item]
              return (
                <Button
                  key={item}
                  type="button"
                  variant={section === item ? 'secondary' : 'ghost'}
                  size="md"
                  align="start"
                  fullWidth
                  active={section === item}
                  onClick={() => setSection(item)}
                  aria-current={section === item ? 'page' : undefined}
                  data-testid={`email-nav-${item}`}
                  className={ws.workspaceNavigationButton}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{SECTION_LABELS[item]}</span>
                </Button>
              )
            })}
          </nav>
        </aside>

        <div className={ws.workspaceContent} aria-labelledby="email-title">
          {section === 'connectors' && (
            <ConnectorsTab
              overview={overview.data}
              loading={overview.loading}
              error={overview.error}
              onChanged={overview.refresh}
              onNavigateToDefaults={() => setSection('defaults')}
            />
          )}
          {section === 'defaults' && (
            <DefaultsTab
              overview={overview.data}
              error={overview.error}
              onChanged={overview.refresh}
              onNavigateToConnectors={() => setSection('connectors')}
            />
          )}
          {section === 'templates' && <TemplatesTab initialKey={templateKey} />}
          {section === 'activity' && (
            <ActivityTab
              capturing={overview.data?.mode === 'capture'}
              onOpenConnectors={() => setSection('connectors')}
              onOpenTemplate={(key) => {
                setTemplateKey(key)
                setSection('templates')
              }}
            />
          )}
        </div>
      </div>
    </AdminPageLayout>
  )
}
