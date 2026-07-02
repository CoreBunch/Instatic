import { reconcileSiteExplorerOrganization, type SiteDocument, type SiteShell } from '@core/page-tree'
import type {
  IPersistenceAdapter,
  SaveSiteOptions,
  SaveSiteResult,
  SiteLoadResult,
} from './types'
import { SaveConflictError, SaveConflictsEnvelopeSchema } from './saveConflict'
import { parseJsonResponse } from '@core/utils/jsonValidate'
import { apiRequest, assertOk, readEnvelope, type FetchLike } from '@core/http'
import {
  CmsSiteEnvelopeSchema,
  CmsSiteDocumentSaveEnvelopeSchema,
  CmsPagesEnvelopeSchema,
  CmsComponentsEnvelopeSchema,
  CmsLayoutsEnvelopeSchema,
} from './responseSchemas'
import { validateSite, validatePages, validateVisualComponents } from './validate'
import { validateSavedLayouts } from './validateLayouts'
import type { DataRow } from '@core/data/schemas'
import { pageFromRow } from '@core/data/pageFromRow'
import { visualComponentFromRow } from '@core/data/componentFromRow'
import { savedLayoutFromRow } from '@core/data/layoutFromRow'
import type { VisualComponent } from '@core/visualComponents'
import type { SavedLayout } from '@core/layouts'

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

/** The three row-backed site collections (the shell is not one of them). */
export type SiteCollectionTable = 'pages' | 'components' | 'layouts'

const COLLECTION_ENVELOPES = {
  pages: CmsPagesEnvelopeSchema,
  components: CmsComponentsEnvelopeSchema,
  layouts: CmsLayoutsEnvelopeSchema,
} as const

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
    const { pages, visualComponents, layouts, ...shell } = site
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

  /**
   * Load the current shell (with its sync seq) on its own — the conflict
   * banner's "Load theirs" fetch for a shell conflict.
   */
  async loadSiteShell(): Promise<{ shell: SiteShell; seq: number } | undefined> {
    const body = await apiRequest(`${this.basePath}/site`, {
      schema: CmsSiteEnvelopeSchema,
      fetchImpl: this.fetchImpl,
      fallbackMessage: 'CMS shell load failed',
    })
    if (!body.site) return undefined
    return { shell: validateSite(body.site), seq: body.seq ?? 0 }
  }

  /**
   * Load a single row of one site collection — the conflict banner's
   * "Load theirs" fetch. Returns null when the row is (soft-)deleted:
   * absence IS the "deleted remotely" signal.
   */
  async loadSiteRow(table: SiteCollectionTable, rowId: string): Promise<DataRow | null> {
    const body = await apiRequest(`${this.basePath}/${table}`, {
      query: { id: rowId },
      schema: COLLECTION_ENVELOPES[table],
      fetchImpl: this.fetchImpl,
      fallbackMessage: `CMS ${table} row load failed`,
    })
    return body.rows?.[0] ?? null
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
   *
   * Alongside the document, returns the sync-seq bases (per-row + shell) the
   * editor tracks for save conflict detection.
   */
  async loadSite(_id: string): Promise<SiteLoadResult | undefined> {
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

    // Sync-seq bases: one entry per stored row (across all three
    // collections — row ids are globally unique) plus the shell's seq.
    const rowSeqs: Record<string, number> = {}
    for (const row of [...rawDataRows, ...rawVCRows, ...(layoutsBody.rows ?? [])]) {
      rowSeqs[row.id] = row.seq ?? 0
    }
    return { site, rowSeqs, shellSeq: shellBody.seq ?? 0 }
  }
}

export const cmsAdapter = new CmsAdapter()
