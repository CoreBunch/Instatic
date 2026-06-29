/**
 * AiPage — `/admin/ai`.
 *
 * Capability-gated workspace for managing AI provider credentials, per-scope
 * defaults, and (Phase 6) the AI usage audit log.
 *
 * Layout mirrors UsersPage — three tabs, each owning its own state. The
 * page itself is thin: it figures out which tabs the current admin can
 * see, loads minimal data, and delegates rendering to per-tab components.
 *
 * Capabilities consulted:
 *   - `ai.providers.manage`  → Providers + Defaults tabs (CRUD)
 *   - `ai.audit.read`        → Audit tab (read site-wide usage)
 */

import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { ProvidersTab } from './tabs/ProvidersTab'
import { DefaultsTab } from './tabs/DefaultsTab'
import { AuditTab } from './tabs/AuditTab'
import { McpTab } from './tabs/McpTab'
import styles from './AiPage.module.css'

type Tab = 'providers' | 'defaults' | 'mcp' | 'audit'

const TAB_LABELS: Record<Tab, string> = {
  providers: 'Providers',
  defaults: 'Defaults',
  mcp: 'MCP',
  audit: 'Audit',
}

export function AiPage() {
  const currentUser = useCurrentAdminUser()
  const unrestricted = !currentUser
  const canManage = unrestricted || hasCapability(currentUser, 'ai.providers.manage')
  const canReadAudit = unrestricted || hasCapability(currentUser, 'ai.audit.read')

  const availableTabs: Tab[] = []
  if (canManage) availableTabs.push('providers', 'defaults', 'mcp')
  if (canReadAudit) availableTabs.push('audit')

  const [tab, setTab] = useState<Tab>('providers')
  const activeTab = availableTabs.includes(tab) ? tab : availableTabs[0] ?? 'providers'

  const tabs = (
    <div role="tablist" aria-label="AI sections" className={styles.tabsRow}>
      {availableTabs.map((item) => (
        <Button
          key={item}
          type="button"
          variant={activeTab === item ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setTab(item)}
          role="tab"
          aria-selected={activeTab === item}
          data-testid={`ai-tab-${item}`}
        >
          <span>{TAB_LABELS[item]}</span>
        </Button>
      ))}
    </div>
  )

  return (
    <AdminPageLayout
      workspace="ai"
      title="AI"
      titleId="ai-title"
      description="Configure AI provider credentials, per-scope defaults, and review usage."
      tabs={tabs}
    >
      <div className={styles.body}>
        {activeTab === 'providers' && <ProvidersTab />}
        {activeTab === 'defaults' && <DefaultsTab />}
        {activeTab === 'mcp' && <McpTab />}
        {activeTab === 'audit' && <AuditTab />}
      </div>
    </AdminPageLayout>
  )
}
