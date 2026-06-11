/**
 * Saved-layout CRUD endpoints backed by `data_rows` (table_id = 'layouts').
 *
 *   GET /admin/api/cms/layouts — list all non-deleted layout rows as
 *                                DataRow[] (gated by `site.read`). The client
 *                                adapter converts these to SavedLayout[]
 *                                via savedLayoutFromRow + validateSavedLayouts.
 *
 *   PUT /admin/api/cms/layouts — incremental roster save. The body carries
 *                                `{ changedLayouts, layoutIds }`: only the
 *                                layouts the editor changed are validated and
 *                                written; `layoutIds` is the client's full
 *                                roster and rows missing from it are reaped —
 *                                identical semantics to the components
 *                                endpoint. Identity rules (unique id + name)
 *                                run against the merged post-save roster (see
 *                                validateSavedLayoutsForPartialWrite).
 *
 *                                Gated by `site.structure.edit` — the
 *                                reconcile soft-deletes any layout missing
 *                                from the incoming roster, mirroring the
 *                                components endpoint's gate.
 *
 * The GET response returns raw DataRow objects (not SavedLayout objects) so
 * the client adapter can reconstruct layouts via savedLayoutFromRow without a
 * second validation layer on the server. The adapter validates via
 * validateSavedLayouts immediately after conversion.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import {
  listDataRows,
  listDataRowIdSlugs,
  createDataRow,
  updateDataRowDraftCells,
  softDeleteDataRow,
} from '../../repositories/data'
import {
  savedLayoutFromRow,
  savedLayoutToCells,
  layoutSlugFromName,
} from '../../../src/core/data/layoutFromRow'
import { SiteValidationError } from '@core/persistence/validate'
import { validateSavedLayoutsForPartialWrite } from '@core/persistence/validateLayouts'
import { SavedLayoutSchema, type SavedLayout } from '@core/layouts'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { CMS_API_PREFIX } from './shared'

export async function handleLayoutsRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/layouts`) return null

  if (req.method === 'GET') {
    const user = await requireCapability(req, db, 'site.read')
    if (user instanceof Response) return user

    const rows = await listDataRows(db, 'layouts')
    return jsonResponse({ rows })
  }

  if (req.method === 'PUT') {
    // Structural gate — reconcile soft-deletes missing layouts.
    const user = await requireCapability(req, db, 'site.structure.edit')
    if (user instanceof Response) return user

    const LayoutsBodySchema = Type.Object({
      // Only the layouts the editor changed since its last save.
      changedLayouts: Type.Array(SavedLayoutSchema),
      // The client's FULL layout-id roster; rows missing from it are reaped.
      layoutIds: Type.Array(Type.String()),
    }, { additionalProperties: false })
    const body = await readValidatedBody(req, LayoutsBodySchema)
    if (!body) return badRequest('Invalid request body')

    const layoutIds = new Set(body.layoutIds)

    // Identity rules (unique id + name) are roster-wide, so validation merges
    // the changed batch over the stored roster. This runs OUTSIDE the
    // transaction (sanitization is CPU work; the SQLite adapter serializes
    // every transaction through one chain).
    const existingRows = await listDataRows(db, 'layouts')
    const existingLayouts = existingRows.flatMap((r) => {
      const layout = savedLayoutFromRow(r)
      return layout ? [layout] : []
    })

    let layouts: SavedLayout[]
    try {
      layouts = validateSavedLayoutsForPartialWrite(body.changedLayouts, existingLayouts, layoutIds)
      for (const layout of layouts) {
        if (!layoutIds.has(layout.id)) {
          throw new SiteValidationError(`changed layout "${layout.id}" missing from layoutIds roster`, 'layoutIds')
        }
      }
    } catch (err) {
      if (err instanceof SiteValidationError) {
        return badRequest(err.message)
      }
      throw err
    }

    // Batch reconcile: create / update / soft-delete in one short transaction.
    await db.transaction(async (tx) => {
      const existingIds = new Set((await listDataRowIdSlugs(tx, 'layouts')).map((r) => r.id))

      for (const layout of layouts) {
        const cells = savedLayoutToCells(layout)
        const slug = layoutSlugFromName(layout.name)
        if (existingIds.has(layout.id)) {
          await updateDataRowDraftCells(tx, layout.id, { cells, slug }, user.id)
        } else {
          await createDataRow(tx, { id: layout.id, tableId: 'layouts', cells, slug }, user.id)
        }
      }

      // Soft-delete rows no longer in the client's roster
      for (const rowId of existingIds) {
        if (!layoutIds.has(rowId)) {
          await softDeleteDataRow(tx, rowId, user.id)
        }
      }
    })

    return jsonResponse({ ok: true })
  }

  return methodNotAllowed()
}
