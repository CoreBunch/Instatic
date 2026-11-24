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

import { Tabs, TabList, Tab, TabPanel } from '@ui/components/Tabs'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useLocation, useNavigate } from '@admin/lib/routing'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { ProvidersTab } from './tabs/ProvidersTab'
import { DefaultsTab } from './tabs/DefaultsTab'
import { AuditTab } from './tabs/AuditTab'
import { ServiceAccountsTab, ServiceConsent } from './tabs/ServiceAccountsTab'
import { McpTab } from './tabs/McpTab'
import { McpOAuthAuthorizePage } from './McpOAuthAuthorizePage'
import directory from '@admin/shared/Directory/Directory.module.css'

type Section = 'providers' | 'defaults' | 'mcp' | 'service' | 'audit'

const SECTION_LABELS: Record<Section, string> = {
  providers: 'Providers',
  defaults: 'Defaults',
  mcp: 'MCP connections',
  service: 'CLI',
  audit: 'Audit',
}

export function AiPage() {
  const location = useLocation()
  const currentUser = useCurrentAdminUser()
  const unrestricted = !currentUser
  const canManage = unrestricted || hasCapability(currentUser, 'ai.providers.manage')
  const canReadAudit = unrestricted || hasCapability(currentUser, 'ai.audit.read')

  const availableSections: Section[] = []
  if (canManage) availableSections.push('providers', 'defaults', 'mcp', 'service')
  if (canReadAudit) availableSections.push('audit')

  const navigate = useNavigate()
  const query = new URLSearchParams(location.search)
  const accountId = query.get('service-account')
  const requested = accountId || query.has('cli') ? 'service' : query.get('tab')
  const activeSection = availableSections.find(item => item === requested) ?? availableSections[0] ?? 'providers'
  function selectSection(section: Section, account?: string) {
    const next = new URLSearchParams(location.search)
    for (const key of ['cli', 'service-account', 'pairing', 'tab']) next.delete(key)
    if (section === 'service') {
      if (account) next.set('service-account', account)
      else next.set('cli', '')
    } else if (section !== 'providers') next.set('tab', section)
    navigate('/admin/ai' + (next.size ? '?' + next.toString() : ''))
  }

  if (location.pathname === '/admin/ai/cli/authorize') return <ServiceConsent />

  if (location.pathname === '/admin/ai/oauth/authorize') {
    return <McpOAuthAuthorizePage />
  }

  return (
    <AdminPageLayout workspace="ai" mode="workspace">
      <Tabs value={activeSection} onChange={selectSection}>
        <div className={directory.workspace}>
          <TabList ariaLabel="AI settings">
            {availableSections.map((item) => (
              <Tab key={item} value={item} testId={`ai-nav-${item}`}>{SECTION_LABELS[item]}</Tab>
            ))}
          </TabList>
          {canManage && <>
            <TabPanel value="providers"><ProvidersTab onNavigateToDefaults={() => selectSection('defaults')} /></TabPanel>
            <TabPanel value="defaults"><DefaultsTab onNavigateToProviders={() => selectSection('providers')} /></TabPanel>
            <TabPanel value="mcp"><McpTab /></TabPanel>
            <TabPanel value="service"><ServiceAccountsTab accountId={accountId} onSelect={id => selectSection('service', id)} /></TabPanel>
          </>}
          {canReadAudit && <TabPanel value="audit"><AuditTab /></TabPanel>}
        </div>
      </Tabs>
    </AdminPageLayout>
  )
}
