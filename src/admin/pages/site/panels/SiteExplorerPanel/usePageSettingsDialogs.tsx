import { useState } from 'react'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import type { Page, PageSeo, PageTemplateConfig } from '@core/page-tree'
import { TemplateSettingsDialog, type TemplateSettingsPayload } from '@admin/shared/dialogs/TemplateSettingsDialog'
import { PageSettingsDialog, type PageSettingsPayload } from '@admin/shared/dialogs/PageSettingsDialog'

interface UsePageSettingsDialogsOptions {
  pages: Page[]
  renamePage: (pageId: string, title: string, slug?: string) => void
  setPageLanguage: (pageId: string, language?: string) => void
  setPageSeo: (pageId: string, seo: PageSeo | undefined) => void
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
  setPageSeo,
  setPageLanguage,
  convertPageToTemplate,
  openPageInCanvas,
}: UsePageSettingsDialogsOptions) {
  const { canEditContent, canEditStructure } = useEditorPermissions()
  const [templateSettingsTarget, setTemplateSettingsTarget] = useState<Page | null>(null)
  const [pageSettingsTarget, setPageSettingsTarget] = useState<Page | null>(null)

  function handleSaveTemplateSettings(payload: TemplateSettingsPayload) {
    if (!templateSettingsTarget) return
    if (canEditStructure) {
      renamePage(templateSettingsTarget.id, payload.title, payload.slug)
      convertPageToTemplate(templateSettingsTarget.id, payload.template)
    }
    if (canEditContent) setPageSeo(templateSettingsTarget.id, payload.seo)
    setTemplateSettingsTarget(null)
    openPageInCanvas(templateSettingsTarget.id)
  }

  function handleSavePageSettings(payload: PageSettingsPayload) {
    if (!pageSettingsTarget) return
    if (canEditStructure) {
      renamePage(pageSettingsTarget.id, payload.title, payload.slug)
      setPageLanguage(pageSettingsTarget.id, payload.language)
    }
    if (canEditContent) setPageSeo(pageSettingsTarget.id, payload.seo)
    setPageSettingsTarget(null)
  }

  const dialogs = (
    <>
      {templateSettingsTarget && (
        <TemplateSettingsDialog
          page={templateSettingsTarget}
          pages={pages}
          canEditSeo={canEditContent}
          canEditStructure={canEditStructure}
          onCancel={() => setTemplateSettingsTarget(null)}
          onSave={handleSaveTemplateSettings}
        />
      )}
      {pageSettingsTarget && (
        <PageSettingsDialog
          page={pageSettingsTarget}
          pages={pages}
          canEditSeo={canEditContent}
          canEditStructure={canEditStructure}
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
