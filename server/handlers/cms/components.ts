/**
 * Visual Components CRUD endpoints backed by `data_rows` (table_id = 'components').
 *
 *   GET /admin/api/cms/components — list all non-deleted component rows as
 *                                   DataRow[] (gated by `site.read`). The client
 *                                   adapter converts these to VisualComponent[]
 *                                   via visualComponentFromRow + validateVisualComponents.
 *
 *   PUT /admin/api/cms/components — incremental roster save. The body carries
 *                                   `{ changedComponents, componentIds }`: only
 *                                   the VCs the editor changed are validated
 *                                   and written; `componentIds` is the client's
 *                                   full roster and rows missing from it are
 *                                   reaped — identical deletion semantics to
 *                                   the old full-replace protocol. Cross-VC
 *                                   rules run against the merged post-save
 *                                   roster (see validateVisualComponentsForPartialWrite).
 *
 *                                   **Gated by `site.structure.edit`** — the
 *                                   reconcile soft-deletes any VC not in the
 *                                   incoming roster. The previous `SITE_WRITE_*`
 *                                   gate let a Client with `site.content.edit`
 *                                   only wipe every Visual Component by sending
 *                                   an empty roster. (A1 fix.)
 *
 * The GET response returns raw DataRow objects (not VisualComponent objects) so
 * the client adapter can reconstruct VCs via visualComponentFromRow without a
 * second validation layer on the server. The adapter validates via
 * validateVisualComponents immediately after conversion.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { listDataRows, reconcileDataRowRoster } from '../../repositories/data'
import { visualComponentToCells, visualComponentFromRow } from '../../../src/core/data/componentFromRow'
import { SiteValidationError, validateVisualComponentsForPartialWrite } from '@core/persistence/validate'
import { VisualComponentSchema, vcSlugFromName, type VisualComponent } from '@core/visualComponents'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { CMS_API_PREFIX } from './shared'

export async function handleComponentsRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/components`) return null

  if (req.method === 'GET') {
    const user = await requireCapability(req, db, 'site.read')
    if (user instanceof Response) return user

    const rows = await listDataRows(db, 'components')
    return jsonResponse({ rows })
  }

  if (req.method === 'PUT') {
    // Structural gate — reconcile soft-deletes missing VCs. See A1.
    const user = await requireCapability(req, db, 'site.structure.edit')
    if (user instanceof Response) return user

    const ComponentsBodySchema = Type.Object({
      // Only the VCs the editor changed since its last save.
      changedComponents: Type.Array(VisualComponentSchema),
      // The client's FULL component-id roster; rows missing from it are reaped.
      componentIds: Type.Array(Type.String()),
    }, { additionalProperties: false })
    const body = await readValidatedBody(req, ComponentsBodySchema)
    if (!body) return badRequest('Invalid request body')

    const componentIds = new Set(body.componentIds)

    // The cross-VC rules (identity, refs, dependency-graph acyclicity) are
    // roster-wide — a changed VC can create a cycle THROUGH an unchanged one —
    // so validation merges the changed batch over the stored roster. This runs
    // OUTSIDE the transaction (sanitization is CPU work; the SQLite adapter
    // serializes every transaction through one chain).
    const existingRows = await listDataRows(db, 'components')
    const existingVCs = existingRows.flatMap((r) => {
      const vc = visualComponentFromRow(r)
      return vc ? [vc] : []
    })

    let components: VisualComponent[]
    try {
      components = validateVisualComponentsForPartialWrite(body.changedComponents, existingVCs, componentIds)
      for (const vc of components) {
        if (!componentIds.has(vc.id)) {
          throw new SiteValidationError(`changed component "${vc.id}" missing from componentIds roster`, 'componentIds')
        }
      }
    } catch (err) {
      if (err instanceof SiteValidationError) {
        return badRequest(err.message)
      }
      throw err
    }

    // Batch reconcile: soft-delete / create / update in one short transaction
    // (reap-first + two-phase slug writes — see rows/reconcile.ts).
    await reconcileDataRowRoster(db, {
      tableId: 'components',
      writes: components.map((vc) => ({
        id: vc.id,
        cells: visualComponentToCells(vc),
        slug: vcSlugFromName(vc.name),
      })),
      keepIds: componentIds,
      actorUserId: user.id,
    })

    return jsonResponse({ ok: true })
  }

  return methodNotAllowed()
}
