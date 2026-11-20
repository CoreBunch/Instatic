import { useState } from 'react'
import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import { parsePageSeo, type PageSeo } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { Settings2SolidIcon } from 'pixel-art-icons/icons/settings-2-solid'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import styles from './SiteExplorerPanel.module.css'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Tabs, TabList } from '@ui/components/Tabs'
import { PageSeoTabs, PageSeoTabPanels, pageSeoProblem } from '@admin/shared/PageSeoEditor'

const EMPTY_SEO: PageSeo = {}

export function GlobalHeadSettings() {
  const [open, setOpen] = useState(false)
  const siteName = useEditorStore((s) => s.site?.name)
  const { canEditStructure } = useEditorPermissions()
  return (
    <>
      <header className={styles.siteRoot}>
        <GlobeSolidIcon size={18} aria-hidden="true" />
        <strong title={siteName}>{siteName}</strong>
        <Button variant="ghost" size="sm" iconOnly aria-label="Global head settings"
          tooltip="Global head settings" aria-haspopup="dialog" disabled={!canEditStructure} onClick={() => setOpen(true)}>
          <Settings2SolidIcon size={16} aria-hidden="true" />
        </Button>
      </header>
      {open && <GlobalHeadDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function GlobalHeadDialog({ onClose }: { onClose: () => void }) {
  const stored = useEditorStore((s) => s.site?.settings.seo)
  const update = useEditorStore((s) => s.updateSiteSettings)
  const [draft, setDraft] = useState<PageSeo>(stored ?? EMPTY_SEO)
  const [tab, setTab] = useState<'search' | 'head'>('search')
  const problem = pageSeoProblem(draft)
  return (
    <Dialog open title="Global head settings" size="xl" onClose={onClose} footer={<>
      {problem && <p role="alert">{problem}</p>}
      <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
      <Button variant="primary" size="sm" disabled={Boolean(problem)} onClick={() => {
        update({ seo: parsePageSeo(draft) ?? undefined })
        onClose()
      }}>Save</Button>
    </>}>
      <div className={dialogStyles.form}>
        <Tabs value={tab} onChange={setTab}>
          <TabList ariaLabel="Global head settings sections"><PageSeoTabs /></TabList>
          <PageSeoTabPanels value={draft} onChange={setDraft} pageTitle="{page.title}"
            note="Defaults for all pages and entries. Templates and individual pages can override each field. Use {page.title} and {site.name} to build a title for each page." />
        </Tabs>
      </div>
    </Dialog>
  )
}
