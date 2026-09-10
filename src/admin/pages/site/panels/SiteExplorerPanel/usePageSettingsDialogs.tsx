import { useState } from 'react'
import { useEditorLocale } from '@site/localization'
import type { Page, PageTemplateConfig } from '@core/page-tree'
import { TemplateSettingsDialog, type TemplateSettingsPayload } from '@admin/shared/dialogs/TemplateSettingsDialog'
import { PageSettingsDialog, type PageSettingsPayload } from '@admin/shared/dialogs/PageSettingsDialog'

interface UsePageSettingsDialogsOptions {
  pages: Page[]
  renamePage: (pageId: string, title: string, slug?: string) => void
  updatePageSeo: (pageId: string, metadata: { title?: string; description?: string }) => void
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
  updatePageSeo,
  convertPageToTemplate,
  openPageInCanvas,
}: UsePageSettingsDialogsOptions) {
  const { localeId } = useEditorLocale()
  const [targets, setTargets] = useState<{ localeId: string | undefined; template: Page | null; page: Page | null }>({ localeId, template: null, page: null })
  // A dialog belongs to the language in which it opened. A workspace switch
  // must not retarget its old title/slug/SEO input to the new language.
  if (targets.localeId !== localeId) setTargets({ localeId, template: null, page: null })
  const templateSettingsTarget = targets.localeId === localeId ? targets.template : null
  const pageSettingsTarget = targets.localeId === localeId ? targets.page : null
  const setTemplateSettingsTarget = (template: Page | null) => setTargets((current) => ({ ...current, localeId, template }))
  const setPageSettingsTarget = (page: Page | null) => setTargets((current) => ({ ...current, localeId, page }))

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
    updatePageSeo(pageSettingsTarget.id, { title: payload.seoTitle, description: payload.seoDescription })
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
