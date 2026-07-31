import { useState } from 'react'
import type { Page, PageTemplateConfig } from '@core/page-tree'
import { TemplateSettingsDialog, type TemplateSettingsPayload } from '@admin/shared/dialogs/TemplateSettingsDialog'
import { PageSettingsDialog, type PageSettingsPayload } from '@admin/shared/dialogs/PageSettingsDialog'

interface UsePageSettingsDialogsOptions {
  pages: Page[]
  renamePage: (pageId: string, title: string, slug?: string) => void
  convertPageToTemplate: (pageId: string, config: PageTemplateConfig) => void
  openPageInCanvas: (pageId: string) => void
}

/**
 * Owns the "Template settings" and "Page settings" dialogs for the site
 * explorer. Both edit a page's title/slug (template settings additionally
 * configures the template target) — grouped here as one unit so
 * SiteExplorerPanel only deals with `open*` triggers, not dialog state.
 */
export function usePageSettingsDialogs({
  pages,
  renamePage,
  convertPageToTemplate,
  openPageInCanvas,
}: UsePageSettingsDialogsOptions) {
  const [templateSettingsTarget, setTemplateSettingsTarget] = useState<Page | null>(null)
  const [pageSettingsTarget, setPageSettingsTarget] = useState<Page | null>(null)

  function handleSaveTemplateSettings(payload: TemplateSettingsPayload) {
    if (!templateSettingsTarget) return
    renamePage(templateSettingsTarget.id, payload.title, payload.slug)
    convertPageToTemplate(templateSettingsTarget.id, payload.template)
    setTemplateSettingsTarget(null)
    openPageInCanvas(templateSettingsTarget.id)
  }

  function handleSavePageSettings(payload: PageSettingsPayload) {
    if (!pageSettingsTarget) return
    renamePage(pageSettingsTarget.id, payload.title, payload.slug)
    setPageSettingsTarget(null)
  }

  const dialogs = (
    <>
      {templateSettingsTarget && (
        <TemplateSettingsDialog
          page={templateSettingsTarget}
          pages={pages}
          onCancel={() => setTemplateSettingsTarget(null)}
          onSave={handleSaveTemplateSettings}
        />
      )}
      {pageSettingsTarget && (
        <PageSettingsDialog
          page={pageSettingsTarget}
          pages={pages}
          onCancel={() => setPageSettingsTarget(null)}
          onSave={handleSavePageSettings}
        />
      )}
    </>
  )

  return {
    openTemplateSettings: setTemplateSettingsTarget,
    openPageSettings: setPageSettingsTarget,
    dialogs,
  }
}
