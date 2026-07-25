/**
 * AiPage — `/admin/ai`.
 *
 * Capability-gated workspace for managing AI provider credentials, per-scope
 * defaults, MCP connections, and the AI usage audit log.
 *
 * Capabilities consulted:
 *   - `ai.providers.manage`  → Providers, Defaults, and MCP connection management
 *   - `ai.audit.read`        → Audit tab (read site-wide usage)
 */

import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useLocation } from '@admin/lib/routing'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { Settings2SolidIcon } from 'pixel-art-icons/icons/settings-2-solid'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { ChartSolidIcon } from 'pixel-art-icons/icons/chart-solid'
import { ProvidersTab } from './tabs/ProvidersTab'
import { DefaultsTab } from './tabs/DefaultsTab'
import { AuditTab } from './tabs/AuditTab'
import { McpTab } from './tabs/McpTab'
import { McpOAuthAuthorizePage } from './McpOAuthAuthorizePage'
import styles from './AiPage.module.css'

type Section = 'providers' | 'defaults' | 'mcp' | 'audit'

const SECTION_LABELS: Record<Section, string> = {
  providers: 'Providers',
  defaults: 'Defaults',
  mcp: 'MCP connections',
  audit: 'Audit',
}

const SECTION_ICONS = {
  providers: DatabaseSolidIcon,
  defaults: Settings2SolidIcon,
  mcp: LinkIcon,
  audit: ChartSolidIcon,
} satisfies Record<Section, typeof DatabaseSolidIcon>

export function AiPage() {
  const location = useLocation()
  const currentUser = useCurrentAdminUser()
  const unrestricted = !currentUser
  const canManage = unrestricted || hasCapability(currentUser, 'ai.providers.manage')
  const canReadAudit = unrestricted || hasCapability(currentUser, 'ai.audit.read')

  const availableSections: Section[] = []
  if (canManage) availableSections.push('providers', 'defaults', 'mcp')
  if (canReadAudit) availableSections.push('audit')

  const [section, setSection] = useState<Section>('providers')
  const activeSection = availableSections.includes(section)
    ? section
    : availableSections[0] ?? 'providers'

  if (location.pathname === '/admin/ai/oauth/authorize') {
    return <McpOAuthAuthorizePage />
  }

  return (
    <AdminPageLayout workspace="ai" mode="workspace">
      <div className={styles.workspace}>
        <aside className={styles.workspaceSidebar} aria-label="AI workspace">
          <div className={styles.workspaceIdentity}>
            <h1 id="ai-title">AI</h1>
            <p>Models, defaults, connections, and usage.</p>
          </div>

          <nav className={styles.workspaceNavigation} aria-label="AI settings">
            {availableSections.map((item) => {
              const Icon = SECTION_ICONS[item]
              return (
                <Button
                  key={item}
                  type="button"
                  variant={activeSection === item ? 'secondary' : 'ghost'}
                  size="md"
                  align="start"
                  fullWidth
                  active={activeSection === item}
                  onClick={() => setSection(item)}
                  aria-current={activeSection === item ? 'page' : undefined}
                  data-testid={`ai-nav-${item}`}
                  className={styles.workspaceNavigationButton}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{SECTION_LABELS[item]}</span>
                </Button>
              )
            })}
          </nav>

        </aside>

        <div className={styles.workspaceContent} aria-labelledby="ai-title">
          {activeSection === 'providers' && (
            <ProvidersTab onNavigateToDefaults={() => setSection('defaults')} />
          )}
          {activeSection === 'defaults' && (
            <DefaultsTab onNavigateToProviders={() => setSection('providers')} />
          )}
          {activeSection === 'mcp' && <McpTab />}
          {activeSection === 'audit' && <AuditTab />}
        </div>
      </div>
    </AdminPageLayout>
  )
}
