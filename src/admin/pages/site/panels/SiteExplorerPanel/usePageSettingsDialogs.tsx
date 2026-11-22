import { Suspense, useState } from 'react'
import type { AccessRule } from '@core/members'
import type { Page, PageSeo, PageTemplateConfig, SiteDocument } from '@core/page-tree'
import type { TemplateSettingsPayload } from '@admin/shared/dialogs/TemplateSettingsDialog'
import type { PageSettingsPayload } from '@admin/shared/dialogs/PageSettingsDialog'

import { mergePageSeo } from '@core/page-tree'
import { resolveTemplateChain } from '@core/templates'

import { PageSettingsDialog, TemplateSettingsDialog } from './lazyPageSettingsDialogs'

interface UsePageSettingsDialogsOptions {
  site: SiteDocument | null
  renamePage: (pageId: string, title: string, slug?: string) => void
  setPageAccess: (pageId: string, access: AccessRule) => void
  setPageSeo: (pageId: string, seo: PageSeo | null) => void
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
  site,
  renamePage,
  setPageAccess,
  setPageSeo,
  convertPageToTemplate,
  openPageInCanvas,
}: UsePageSettingsDialogsOptions) {
  const [templateSettingsTarget, setTemplateSettingsTarget] = useState<Page | null>(null)
  const [pageSettingsTarget, setPageSettingsTarget] = useState<Page | null>(null)

  function handleSaveTemplateSettings(payload: TemplateSettingsPayload) {
    if (!templateSettingsTarget) return
    renamePage(templateSettingsTarget.id, payload.title, payload.slug)
    convertPageToTemplate(templateSettingsTarget.id, payload.template)
    setPageSeo(templateSettingsTarget.id, payload.seo)
    setTemplateSettingsTarget(null)
    openPageInCanvas(templateSettingsTarget.id)
  }

  function handleSavePageSettings(payload: PageSettingsPayload) {
    if (!pageSettingsTarget) return
    renamePage(pageSettingsTarget.id, payload.title, payload.slug)
    setPageAccess(pageSettingsTarget.id, payload.access)
    setPageSeo(pageSettingsTarget.id, payload.seo)
    setPageSettingsTarget(null)
  }

  const settings = site?.settings
  const globalDefaults = mergePageSeo({
    title: settings?.metaTitle,
    description: settings?.metaDescription,
    favicon: settings?.faviconUrl ? { href: settings.faviconUrl } : undefined,
  }, settings?.seo)
  // A post-type or 404 template can inherit the everywhere template. An
  // everywhere template only inherits the site defaults, including on creation.
  const matchingSite = site && templateSettingsTarget
    ? { ...site, pages: site.pages.filter((page) => page.id !== templateSettingsTarget.id) }
    : site
  const layout = matchingSite && (templateSettingsTarget || pageSettingsTarget)
    ? resolveTemplateChain(matchingSite, { kind: 'page' })[0] : undefined
  const templateDefaults = mergePageSeo(globalDefaults, layout?.seo)
  const dialogs = (
    <Suspense fallback={null}>
      {templateSettingsTarget && (
        <TemplateSettingsDialog
          globalDefaults={globalDefaults}
          templateDefaults={templateDefaults}
          page={templateSettingsTarget}
          pages={site?.pages ?? []}
          onCancel={() => setTemplateSettingsTarget(null)}
          onSave={handleSaveTemplateSettings}
        />
      )}
      {pageSettingsTarget && (
        <PageSettingsDialog
          inherited={templateDefaults}
          siteFrame={site ? { id: site.id, name: site.name } : undefined}
          page={pageSettingsTarget}
          pages={site?.pages ?? []}
          onCancel={() => setPageSettingsTarget(null)}
          onSave={handleSavePageSettings}
        />
      )}
    </Suspense>
  )

  return {
    openTemplateSettings: setTemplateSettingsTarget,
    openPageSettings: setPageSettingsTarget,
    dialogs,
  }
}
