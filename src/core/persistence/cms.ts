import { reconcileSiteExplorerOrganization, type SiteDocument } from '@core/page-tree'
import type {
  IPersistenceAdapter,
  SaveSiteOptions,
  SaveSiteResult,
  SiteLoadResult,
} from './types'
import { SaveConflictError, SaveConflictsEnvelopeSchema } from './saveConflict'
import { parseJsonResponse } from '@core/utils/jsonValidate'
import { readEnvelope, type FetchLike } from '@core/http'
import { CmsSiteDocumentEnvelopeSchema, CmsSiteDocumentSaveEnvelopeSchema } from './responseSchemas'
import { validateSite, validatePages, validateVisualComponents } from './validate'
import { validateSavedLayouts } from './validateLayouts'

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
   * Save the site document — ONE request, one server transaction:
   *
   *   PUT /admin/api/cms/site-document
   *
   * With `opts.dirty` (and not `dirty.all`), ships an incremental save: only
   * the changed pages/components/layouts plus the explicitly deleted row ids
   * the store's dirty tracking recorded. Rows the save doesn't mention are
   * untouched server-side — deletion is stated intent, never inferred from a
   * missing roster entry. Without hints (or with `dirty.all`) ships a
   * replace-mode full save: the server derives deletions as stored − shipped
   * (imports, fresh-site bootstrap).
   *
   * The old ordering contract (components before pages so refs resolve) is
   * gone: the server validates pages against the merged post-save component
   * roster inside the same transaction.
   */
  async saveSite(site: SiteDocument, opts: SaveSiteOptions = {}): Promise<SaveSiteResult> {
    // Extract shell (strip the row-backed collections from the full SiteDocument)
    const { pages, visualComponents, layouts, localeId, locales: _locales, localization: _localization, ...shell } = site
    const { dirty } = opts
    const incremental = dirty !== undefined && !dirty.all

    // Ship the base seqs covering exactly the rows this save touches —
    // changed AND deleted (deleting a remotely-newer row is an overwrite
    // too). Rows the client has never synchronized (its own creations) have
    // no entry, which is how the server tells creations apart.
    const baseSeqs: Record<string, number> = {}
    if (incremental) {
      const shippedIds = [
        ...dirty.pageIds, ...dirty.deletedPageIds,
        ...dirty.componentIds, ...dirty.deletedComponentIds,
        ...dirty.layoutIds, ...dirty.deletedLayoutIds,
      ]
      for (const id of shippedIds) {
        const base = opts.baseSeqs?.[id]
        if (base !== undefined) baseSeqs[id] = base
      }
    }

    const body = incremental
      ? {
          mode: 'incremental',
          localeId,
          site: shell,
          changedPages: pages.filter((p) => dirty.pageIds.has(p.id)),
          deletedPageIds: [...dirty.deletedPageIds],
          changedComponents: visualComponents.filter((vc) => dirty.componentIds.has(vc.id)),
          deletedComponentIds: [...dirty.deletedComponentIds],
          changedLayouts: layouts.filter((layout) => dirty.layoutIds.has(layout.id)),
          deletedLayoutIds: [...dirty.deletedLayoutIds],
          baseSeqs,
          shellBaseSeq: opts.shellBaseSeq ?? 0,
        }
      : {
          mode: 'replace',
          localeId,
          site: shell,
          changedPages: pages,
          deletedPageIds: [],
          changedComponents: visualComponents,
          deletedComponentIds: [],
          changedLayouts: layouts,
          deletedLayoutIds: [],
          // Ignored in replace mode — imports and bootstraps replace
          // deliberately, so there is nothing to conflict with.
          baseSeqs,
          shellBaseSeq: opts.shellBaseSeq ?? 0,
        }

    // Own fetch instead of `apiRequest`: a 409 carries the typed conflicts
    // payload, which the generic ApiError cannot transport.
    const res = await this.fetchImpl(`${this.basePath}/site-document`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 409) {
      const conflictBody = await parseJsonResponse(res, SaveConflictsEnvelopeSchema)
      throw new SaveConflictError(conflictBody.conflicts)
    }
    const saved = await readEnvelope(res, CmsSiteDocumentSaveEnvelopeSchema, 'Site save failed')
    return { seq: saved.seq }
  }

  /** Load one consistent authoring snapshot, including sparse translation contexts. */
  async loadSite(_id: string, localeId?: string): Promise<SiteLoadResult | undefined> {
    const query = localeId ? `?localeId=${encodeURIComponent(localeId)}` : ''
    const response = await this.fetchImpl(`${this.basePath}/site-document${query}`, {
      method: 'GET', credentials: 'include',
    })
    if (response.status === 404) return undefined
    const body = await readEnvelope(response, CmsSiteDocumentEnvelopeSchema, 'CMS site load failed')
    const shell = validateSite(body.site)
    const visualComponents = validateVisualComponents(body.site.visualComponents)
    const layouts = validateSavedLayouts(body.site.layouts)
    const pages = validatePages(shell, body.site.pages, visualComponents, { tolerant: true })
    const site: SiteDocument = {
      ...shell, pages, visualComponents, layouts,
      localeId: body.site.localeId, locales: body.site.locales, localization: body.site.localization,
    }
    site.explorer = reconcileSiteExplorerOrganization(site.explorer, site)
    return { site, rowSeqs: body.rowSeqs, shellSeq: body.shellSeq }
  }
}

export const cmsAdapter = new CmsAdapter()
