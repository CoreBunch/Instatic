/**
 * Pages CRUD endpoints backed by `data_rows` (table_id = 'pages').
 *
 *   GET /admin/api/cms/pages — list all non-deleted page rows as DataRow[]
 *                              (gated by `site.read`). The client adapter
 *                              converts these to Page[] via pageFromRow.
 *
 *   PUT /admin/api/cms/pages — batch upsert the full page roster. The body
 *                              carries `{ pages: Page[] }` (the in-memory
 *                              representation from the editor store). The
 *                              server validates them, converts to cells via
 *                              pageToCells, and reconciles create/update/delete
 *                              against the current rows in one transaction.
 *
 *                              **Gated by `site.structure.edit`** — the reconcile
 *                              soft-deletes any row not in the incoming set,
 *                              so this endpoint can wipe pages wholesale. The
 *                              previous `SITE_WRITE_CAPABILITIES` gate let a
 *                              Client with `site.content.edit` only also send
 *                              `{ pages: [] }` and erase every page. (A1
 *                              fix — see capabilities review.)
 *
 *                              Per-node content edits stay on the site-shell
 *                              save path, which IS diff-validated.
 *
 * The GET response intentionally returns raw DataRow objects (not Page objects)
 * so the client adapter can reconstruct Pages via pageFromRow without a
 * round-trip through a second validation layer on the server. The adapter
 * validates pages via validatePages immediately after conversion.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { getDraftSite } from '../../repositories/site'
import {
  listDataRows,
  createDataRow,
  saveDataRowDraft,
  softDeleteDataRow,
} from '../../repositories/data'
import { pageToCells } from '../../../src/core/data/pageFromRow'
import { visualComponentFromRow } from '../../../src/core/data/componentFromRow'
import { validatePages, SiteValidationError } from '@core/persistence/validate'
import type { Page } from '@core/page-tree'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { bumpPublishVersionSerialized } from '../../publish/publishState'
import { Type } from '@core/utils/typeboxHelpers'
import { CMS_API_PREFIX } from './shared'

/**
 * Decide which existing `pages` rows to soft-delete during a roster reconcile.
 *
 * With `baselineIds` (the page ids the saving client loaded), only reap a row
 * the client knew about and dropped — never a row another session created
 * concurrently, which the saving client never saw (ISS-041). With no baseline,
 * reap every row missing from the incoming set (authoritative full replace,
 * e.g. an import).
 */
export function pagesToReap(
  existingIds: string[],
  incomingIds: ReadonlySet<string>,
  baselineIds?: ReadonlySet<string>,
): string[] {
  return existingIds.filter((id) => !incomingIds.has(id) && (baselineIds ? baselineIds.has(id) : true))
}

export async function handlePagesRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/pages`) return null

  if (req.method === 'GET') {
    const user = await requireCapability(req, db, 'site.read')
    if (user instanceof Response) return user

    const rows = await listDataRows(db, 'pages')
    return jsonResponse({ rows })
  }

  if (req.method === 'PUT') {
    // Structural gate. The reconcile soft-deletes any row missing from
    // the incoming set — a Client with `site.content.edit` only must
    // not be able to trigger that. Per-node content edits flow through
    // the site-shell save endpoint, which has its own diff validator.
    const user = await requireCapability(req, db, 'site.structure.edit')
    if (user instanceof Response) return user

    const PagesBodySchema = Type.Object({
      pages: Type.Array(Type.Unknown()),
      // Optimistic-concurrency token: the page ids the client loaded. When
      // present, the reconcile only reaps rows the client knew about, so a
      // sibling session's just-created page is never silently deleted (ISS-041).
      // Absent = authoritative full replace (import).
      baselinePageIds: Type.Optional(Type.Array(Type.String())),
    })
    const body = await readValidatedBody(req, PagesBodySchema)
    if (!body) return badRequest('Invalid request body')
    const rawPages = body.pages

    // Load current shell and VC roster for full validatePages context
    const [shell, vcRows] = await Promise.all([
      getDraftSite(db),
      listDataRows(db, 'components'),
    ])
    if (!shell) return jsonResponse({ error: 'draft site not found' }, { status: 404 })

    const visualComponents = vcRows.flatMap((r) => {
      const vc = visualComponentFromRow(r)
      return vc ? [vc] : []
    })

    let pages: Page[]
    try {
      pages = validatePages(shell, rawPages, visualComponents)
    } catch (err) {
      if (err instanceof SiteValidationError) return badRequest(err.message)
      throw err
    }

    // Batch reconcile: create / update / soft-delete in a transaction
    let reapedPublished = false
    await db.transaction(async (tx) => {
      const existingRows = await listDataRows(tx, 'pages')
      const existingById = new Map(existingRows.map((r) => [r.id, r]))
      const incomingIds = new Set(pages.map((p) => p.id))
      const baselineIds = body.baselinePageIds ? new Set(body.baselinePageIds) : undefined

      for (const page of pages) {
        const cells = pageToCells(page)
        if (existingById.has(page.id)) {
          await saveDataRowDraft(tx, page.id, { cells, slug: page.slug }, user.id)
        } else {
          await createDataRow(tx, { id: page.id, tableId: 'pages', cells, slug: page.slug }, user.id)
        }
      }

      // Soft-delete only the rows the client knew about and dropped — never a
      // concurrently-created sibling page (ISS-041).
      for (const rowId of pagesToReap([...existingById.keys()], incomingIds, baselineIds)) {
        const deleted = await softDeleteDataRow(tx, rowId, user.id)
        if (deleted?.status === 'published') reapedPublished = true
      }
    })

    // Reaping a published page retracts its public route — invalidate the
    // render cache AFTER the transaction commits (never inside it: the bump
    // serializes against the publish lock, which itself waits on the
    // transaction chain).
    if (reapedPublished) await bumpPublishVersionSerialized()

    return jsonResponse({ ok: true })
  }

  return methodNotAllowed()
}
