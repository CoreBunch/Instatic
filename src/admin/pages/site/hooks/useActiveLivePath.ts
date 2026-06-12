/**
 * useActiveLivePath — owns `adminUi.activeLivePath` for the Site editor.
 *
 * The toolbar's `OpenLivePageButton` deep-links to whatever public path this
 * hook publishes. Resolving that path is NOT just "the active page's slug":
 * templates are not routable pages. A template's own slug (e.g. `global-layout`
 * for an Everywhere layout) has no public route, so opening it 404s. What the
 * author actually wants — and what the canvas already advertises via the
 * "Previewing X" selector — is the page / post the template is being previewed
 * against.
 *
 * Resolution:
 *   - Regular page            → `pagePublicPath(slug)` (e.g. `/about`, home → `/`).
 *   - Everywhere template      → the previewed page's public path. Defaults to
 *     the first non-template page, matching `TemplateModeControl`'s own default.
 *   - postTypes template       → the previewed published row's permalink.
 *     Defaults to the first published row (newest first), again matching the
 *     preview-source dropdown.
 *   - notFound template        → `/404`, the baked 404 artefact's path.
 *
 * Mounted once from `AdminCanvasEditorBody` (the lazy editor body) so the CMS
 * data fetch needed for the postTypes case stays out of the always-loaded admin
 * shell bundle. It is the single writer of `activeLivePath` in the Site editor;
 * it clears the field on unmount so navigating away from the editor leaves the
 * toolbar pointing at the site root again.
 */
import { useEffect } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { selectActivePage, useEditorStore } from '@site/store/store'
import { isTemplatePage, primaryTemplateTableSlug } from '@core/templates'
import { pagePublicPath, type TemplateTarget } from '@core/page-tree'
import { getCmsDataTableBySlug, previewCmsDataLoopItems } from '@core/persistence/cmsData'
import type { LoopItem } from '@core/loops/types'

const EMPTY_ITEMS: LoopItem[] = []

export function useActiveLivePath(): void {
  const publish = useAdminUi((s) => s.setActiveLivePath)
  const activePage = useEditorStore(selectActivePage)
  const sitePages = useEditorStore((s) => s.site?.pages ?? null)
  const selection = useEditorStore((s) =>
    activePage ? s.templatePreviewSelection[activePage.id] ?? null : null,
  )

  const isTemplate = activePage ? isTemplatePage(activePage) : false
  const targetKind = activePage?.template?.target?.kind ?? null

  // Published rows backing a postTypes template's preview. Resolves to an empty
  // list for every other case (regular page / everywhere template) so the hook
  // stays cheap — the loader short-circuits before any network call.
  const tableSlug =
    isTemplate && targetKind === 'postTypes' && activePage
      ? primaryTemplateTableSlug(activePage)
      : null
  const { data: rows } = useAsyncResource<LoopItem[]>(
    () =>
      tableSlug
        ? getCmsDataTableBySlug(tableSlug)
            .then(async (table) => {
              if (!table) return EMPTY_ITEMS
              const { items } = await previewCmsDataLoopItems(table.id, {
                orderBy: 'publishedAt',
                direction: 'desc',
                limit: 50,
              })
              return items
            })
            .catch(() => EMPTY_ITEMS)
        : Promise.resolve(EMPTY_ITEMS),
    [tableSlug],
  )

  const livePath = resolveLivePath({
    activePage,
    isTemplate,
    targetKind,
    selection,
    sitePages,
    rows: rows ?? EMPTY_ITEMS,
  })

  useEffect(() => {
    publish(livePath)
    return () => publish(null)
  }, [livePath, publish])
}

interface ResolveArgs {
  activePage: ReturnType<typeof selectActivePage>
  isTemplate: boolean
  targetKind: TemplateTarget['kind'] | null
  selection: string | null
  sitePages: ReturnType<typeof selectActivePage>[] | null
  rows: LoopItem[]
}

/**
 * Pure resolver behind `useActiveLivePath` — exported for unit testing. Maps the
 * active document + template-preview selection to the public path the "Open live
 * page" button should open. Returns null when nothing routable can be resolved
 * (the button then falls back to the site root).
 */
export function resolveLivePath({
  activePage,
  isTemplate,
  targetKind,
  selection,
  sitePages,
  rows,
}: ResolveArgs): string | null {
  if (!activePage) return null

  // Regular page (or VC mode falling back to its underlying page): the slug is
  // a real route.
  if (!isTemplate) return pagePublicPath(activePage.slug)

  if (targetKind === 'everywhere') {
    const candidates = (sitePages ?? []).filter(
      (page): page is NonNullable<typeof page> => page != null && !isTemplatePage(page),
    )
    const previewed = candidates.find((page) => page.id === selection) ?? candidates[0] ?? null
    return previewed ? pagePublicPath(previewed.slug) : null
  }

  if (targetKind === 'postTypes') {
    const previewed = rows.find((item) => item.id === selection) ?? rows[0] ?? null
    const permalink = previewed?.fields.permalink
    return typeof permalink === 'string' && permalink ? permalink : null
  }

  // notFound template: `/404` serves its baked artefact (the same body every
  // unmatched URL gets with status 404), so it is the natural live preview.
  if (targetKind === 'notFound') return '/404'

  return null
}
