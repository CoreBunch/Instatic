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
import { Tabs, TabList, Tab, TabPanel } from '@ui/components/Tabs'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useLocation } from '@admin/lib/routing'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { ProvidersTab } from './tabs/ProvidersTab'
import { DefaultsTab } from './tabs/DefaultsTab'
import { AuditTab } from './tabs/AuditTab'
import { McpTab } from './tabs/McpTab'
import { McpOAuthAuthorizePage } from './McpOAuthAuthorizePage'
import directory from '@admin/shared/Directory/Directory.module.css'

type Section = 'providers' | 'defaults' | 'mcp' | 'audit'

const SECTION_LABELS: Record<Section, string> = {
  providers: 'Providers',
  defaults: 'Defaults',
  mcp: 'MCP connections',
  audit: 'Audit',
}

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
      <Tabs value={activeSection} onChange={setSection}>
        <div className={directory.workspace}>
          <TabList ariaLabel="AI settings">
            {availableSections.map((item) => (
              <Tab key={item} value={item} testId={`ai-nav-${item}`}>{SECTION_LABELS[item]}</Tab>
            ))}
          </TabList>
          {canManage && <>
            <TabPanel value="providers"><ProvidersTab onNavigateToDefaults={() => setSection('defaults')} /></TabPanel>
            <TabPanel value="defaults"><DefaultsTab onNavigateToProviders={() => setSection('providers')} /></TabPanel>
            <TabPanel value="mcp"><McpTab /></TabPanel>
          </>}
          {canReadAudit && <TabPanel value="audit"><AuditTab /></TabPanel>}
        </div>
      </Tabs>
    </AdminPageLayout>
  )
}
