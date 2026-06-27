/**
 * SeoPage — `/admin/tools/seo`.
 *
 * The SEO & AEO workspace: per-target metadata editing with live 1:1
 * platform previews and a scored control-center overview (Meta tab),
 * generated robots.txt with AI-crawler controls (Robots.txt tab), and
 * sitemap generation settings (Sitemap tab).
 *
 * Tab chrome matches the sibling AI / Users / Account pages: the same
 * capability-gated Button row passed through AdminPageLayout's `tabs` slot
 * (§T.6 in `no-plugin-tab-shells.test.ts`).
 *
 * Save/publish lives in the TOOLBAR, like the Site and Content workspaces:
 * the active editor registers itself on the save bridge
 * (`useSeoSaveBridge`), and `SeoToolbar` renders the shared
 * PublishActionGroup in the layout's `toolbarRightSlot`.
 *
 * Capabilities: `seo.read` gates the workspace (enforced by
 * `canAccessWorkspace`); `seo.manage` gates every write — tabs receive
 * `canManage` and disable their editing affordances with inline reasons.
 */

import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { MetaTab } from './tabs/MetaTab'
import { RobotsTab } from './tabs/RobotsTab'
import { SitemapTab } from './tabs/SitemapTab'
import { SeoToolbar } from './components/SeoToolbar'
import { useSeoWorkspace } from './hooks/useSeoWorkspace'
import { useSeoSaveBridge } from './hooks/useSeoSaveBridge'
import styles from './SeoPage.module.css'

type Tab = 'meta' | 'robots' | 'sitemap'

const TAB_LABELS: Record<Tab, string> = {
  meta: 'Meta',
  robots: 'Robots.txt',
  sitemap: 'Sitemap',
}

const ALL_TABS: Tab[] = ['meta', 'robots', 'sitemap']

export function SeoPage() {
  const currentUser = useCurrentAdminUser()
  const unrestricted = !currentUser
  const canManage = unrestricted || hasCapability(currentUser, 'seo.manage')

  const [tab, setTab] = useState<Tab>('meta')
  const workspace = useSeoWorkspace()
  const bridge = useSeoSaveBridge()

  const tabs = (
    <div role="tablist" aria-label="SEO sections" className={styles.tabsRow}>
      {ALL_TABS.map((item) => (
        <Button
          key={item}
          type="button"
          variant={tab === item ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setTab(item)}
          role="tab"
          aria-selected={tab === item}
          data-testid={`seo-tab-${item}`}
        >
          <span>{TAB_LABELS[item]}</span>
        </Button>
      ))}
    </div>
  )

  return (
    <AdminPageLayout
      workspace="seo"
      title="SEO"
      titleId="seo-title"
      description="Search and answer-engine optimization: metadata, social cards, structured data, robots, and sitemap."
      tabs={tabs}
      toolbarRightSlot={(
        <SeoToolbar status={bridge.status} onSave={bridge.save} onPublish={bridge.publish} />
      )}
      loading={workspace.loading}
    >
      {workspace.error ? (
        <p className={styles.loadError} role="alert">{workspace.error}</p>
      ) : (
        <div className={styles.body}>
          {tab === 'meta' && <MetaTab workspace={workspace} canManage={canManage} bridge={bridge} />}
          {tab === 'robots' && <RobotsTab workspace={workspace} canManage={canManage} bridge={bridge} />}
          {tab === 'sitemap' && <SitemapTab workspace={workspace} canManage={canManage} bridge={bridge} />}
        </div>
      )}
    </AdminPageLayout>
  )
}
