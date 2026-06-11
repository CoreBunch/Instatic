import { reconcileSiteExplorerOrganization, type SiteDocument, type SiteShell } from '@core/page-tree'
import type { IPersistenceAdapter, SaveSiteOptions } from './types'
import { parseJsonResponse } from '@core/utils/jsonValidate'
import { apiRequest, assertOk, type FetchLike } from '@core/http'
import { CmsSiteEnvelopeSchema, CmsPagesEnvelopeSchema, CmsComponentsEnvelopeSchema, CmsLayoutsEnvelopeSchema } from './responseSchemas'
import { validateSite, validatePages, validateVisualComponents } from './validate'
import { validateSavedLayouts } from './validateLayouts'
import { pageFromRow } from '@core/data/pageFromRow'
import { visualComponentFromRow } from '@core/data/componentFromRow'
import { savedLayoutFromRow } from '@core/data/layoutFromRow'
import type { VisualComponent } from '@core/visualComponents'
import type { SavedLayout } from '@core/layouts'

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

export class CmsAdapter implements IPersistenceAdapter {
  private readonly fetchImpl: FetchLike
  private readonly basePath: string

  constructor(
    fetchImpl: FetchLike = defaultFetch,
    basePath = '/admin/api/cms',
  ) {
    this.fetchImpl = fetchImpl
    this.basePath = basePath
  }

  /**
   * Save the site document:
   *   1. PUT /admin/api/cms/site — the shell (no pages, VCs, or layouts); always written
   *   2. PUT /admin/api/cms/pages — `{ changedPages, pageIds, baselinePageIds? }`
   *   3. PUT /admin/api/cms/components — `{ changedComponents, componentIds }`
   *   4. PUT /admin/api/cms/layouts — `{ changedLayouts, layoutIds }`
   *
   * Only the pages/components/layouts named dirty by `opts.dirty` are shipped —
   * the full id rosters always go along so the server's reaping (delete-what's-
   * missing) semantics are identical to a full replace. No dirty hints (or
   * `dirty.all`) ships everything: the conservative path for imports and any
   * caller without store-level tracking.
   *
   * Shell is written first; pages, components, and layouts can then be written
   * in parallel since they do not depend on each other.
   */
  async saveSite(site: SiteDocument, opts: SaveSiteOptions = {}): Promise<void> {
    // Extract shell (strip the row-backed collections from the full SiteDocument)
    const { pages, visualComponents, layouts, ...shell } = site
    const { baselinePageIds, dirty } = opts

    const changedPages = dirty && !dirty.all
      ? pages.filter((p) => dirty.pageIds.has(p.id))
      : pages
    const changedComponents = dirty && !dirty.all
      ? visualComponents.filter((vc) => dirty.componentIds.has(vc.id))
      : visualComponents
    const changedLayouts = dirty && !dirty.all
      ? layouts.filter((layout) => dirty.layoutIds.has(layout.id))
      : layouts

    await apiRequest(`${this.basePath}/site`, {
      method: 'PUT',
      body: { site: shell },
      fetchImpl: this.fetchImpl,
      fallbackMessage: 'CMS shell save failed',
    })

    // Pages, components, and layouts can be written in parallel — none of them
    // depends on another.
    await Promise.all([
      apiRequest(`${this.basePath}/pages`, {
        method: 'PUT',
        body: {
          changedPages,
          pageIds: pages.map((p) => p.id),
          ...(baselinePageIds ? { baselinePageIds } : {}),
        },
        fetchImpl: this.fetchImpl,
        fallbackMessage: 'CMS pages save failed',
      }),
      apiRequest(`${this.basePath}/components`, {
        method: 'PUT',
        body: {
          changedComponents,
          componentIds: visualComponents.map((vc) => vc.id),
        },
        fetchImpl: this.fetchImpl,
        fallbackMessage: 'CMS components save failed',
      }),
      apiRequest(`${this.basePath}/layouts`, {
        method: 'PUT',
        body: {
          changedLayouts,
          layoutIds: layouts.map((layout) => layout.id),
        },
        fetchImpl: this.fetchImpl,
        fallbackMessage: 'CMS layouts save failed',
      }),
    ])
  }

  /**
   * Load the full site document:
   *   1. GET /admin/api/cms/site — shell (validated by validateSite)
   *   2. GET /admin/api/cms/pages — DataRow[] (converted via pageFromRow,
   *      validated by validatePages with shell context)
   *   3. GET /admin/api/cms/components — DataRow[] (converted via
   *      visualComponentFromRow, validated by validateVisualComponents)
   *   4. GET /admin/api/cms/layouts — DataRow[] (converted via
   *      savedLayoutFromRow, validated by validateSavedLayouts)
   *
   * Returns undefined when any endpoint returns 404 (before setup).
   */
  async loadSite(_id: string): Promise<SiteDocument | undefined> {
    // Parallel fetch — all four are GETs with no dependency on each other
    const [shellRes, pagesRes, componentsRes, layoutsRes] = await Promise.all([
      this.fetchImpl(`${this.basePath}/site`, {
        method: 'GET',
        credentials: 'include',
      }),
      this.fetchImpl(`${this.basePath}/pages`, {
        method: 'GET',
        credentials: 'include',
      }),
      this.fetchImpl(`${this.basePath}/components`, {
        method: 'GET',
        credentials: 'include',
      }),
      this.fetchImpl(`${this.basePath}/layouts`, {
        method: 'GET',
        credentials: 'include',
      }),
    ])

    if (
      shellRes.status === 404 ||
      pagesRes.status === 404 ||
      componentsRes.status === 404 ||
      layoutsRes.status === 404
    ) return undefined
    await assertOk(shellRes, `CMS shell load failed with ${shellRes.status}`)
    await assertOk(pagesRes, `CMS pages load failed with ${pagesRes.status}`)
    await assertOk(componentsRes, `CMS components load failed with ${componentsRes.status}`)
    await assertOk(layoutsRes, `CMS layouts load failed with ${layoutsRes.status}`)

    const shellBody = await parseJsonResponse(shellRes, CmsSiteEnvelopeSchema)
    const pagesBody = await parseJsonResponse(pagesRes, CmsPagesEnvelopeSchema)
    const componentsBody = await parseJsonResponse(componentsRes, CmsComponentsEnvelopeSchema)
    const layoutsBody = await parseJsonResponse(layoutsRes, CmsLayoutsEnvelopeSchema)

    if (!shellBody.site) return undefined

    // Validate shell
    const shell: SiteShell = validateSite(shellBody.site)

    // Convert DataRow[] → VisualComponent[] → validate
    const rawVCRows = componentsBody.rows ?? []
    const rawVCs = rawVCRows.flatMap((row) => {
      const vc = visualComponentFromRow(row)
      return vc ? [vc] : []
    })
    const visualComponents: VisualComponent[] = validateVisualComponents(rawVCs)

    // Convert DataRow[] → SavedLayout[] → validate
    const rawLayouts = (layoutsBody.rows ?? []).flatMap((row) => {
      const layout = savedLayoutFromRow(row)
      return layout ? [layout] : []
    })
    const layouts: SavedLayout[] = validateSavedLayouts(rawLayouts)

    // Convert DataRow[] → Page[] → validate (passes VCs for ref/slot checks)
    const rawDataRows = pagesBody.rows ?? []
    const rawPages = rawDataRows.map(pageFromRow)
    // Load is tolerant: one corrupt page row must not brick the whole editor
    // (ISS-017). Strip page VC-refs only against the ids genuinely in storage
    // (rawVCs), so a VC the loader deduped/de-cycled away does not delete the
    // page's authored slot content (ISS-016).
    const pages = validatePages(shell, rawPages, visualComponents, {
      tolerant: true,
      storedVcIds: new Set(rawVCs.map((vc) => vc.id)),
    })

    const site: SiteDocument = { ...shell, pages, visualComponents, layouts }
    site.explorer = reconcileSiteExplorerOrganization(site.explorer, site)
    return site
  }
}

export const cmsAdapter = new CmsAdapter()
