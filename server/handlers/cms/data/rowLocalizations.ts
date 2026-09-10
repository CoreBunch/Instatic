import { Type } from '@core/utils/typeboxHelpers'
import { createTranslationFieldMetadata, parseLocaleTreeCell, resolveDataFieldLocalization, resetLocalizedNodeProperty } from '@core/localization'
import type { DbClient } from '../../../db/client'
import { requireAuthenticatedUser } from '../../../auth/authz'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../../http'
import { getDataRow, getDataTable } from '../../../repositories/data'
import { getDefaultLocale, listLocales, saveContentLocalizationDraft } from '../../../repositories/localization'
import { notifyRowWrite, serializeCollabAwareWrite } from '../../../repositories/rowWriteEvents'
import { loadDataRowForAccess } from './access'
import { createAuditEvent } from '../../../repositories/audit'
import { requestAuditContext } from '../shared'

const TranslationActionSchema = Type.Object({
  action: Type.Union([Type.Literal('reset'), Type.Literal('review')]),
  fieldId: Type.String({ minLength: 1 }),
  nodeId: Type.Optional(Type.String({ minLength: 1 })),
  property: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false })

export async function handleRowLocalizationRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const match = /^\/admin\/api\/cms\/data\/rows\/([^/]+)\/(localizations|translation)$/.exec(new URL(req.url).pathname)
  if (!match) return null
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  const read = match[2] === 'localizations'
  if (req.method !== (read ? 'GET' : 'POST')) return methodNotAllowed()
  const current = await loadDataRowForAccess(req, db, match[1], user, read ? 'read' : 'localize')
  if (current instanceof Response) return current

  if (read) {
    const locales = await listLocales(db)
    const rows = await Promise.all(locales.map((locale) => getDataRow(db, current.id, locale.id)))
    const table = await getDataTable(db, current.tableId)
    return jsonResponse({ locales, rows: rows.filter((row) => row !== null), fields: table?.fields ?? [] })
  }

  const body = await readValidatedBody(req, TranslationActionSchema)
  if (!body) return badRequest('Invalid translation action')
  if (body.action === 'review' && (body.nodeId || body.property)) {
    return badRequest('Translation review applies to a whole field; node property review is not supported')
  }
  const sourceLocale = await getDefaultLocale(db)
  if (current.localeId === sourceLocale.id) return badRequest('The source language does not inherit a translation')
  const table = await getDataTable(db, current.tableId)
  const field = table?.fields.find((candidate) => candidate.id === body.fieldId)
  if (!field || resolveDataFieldLocalization(field) !== 'localized') return badRequest('This field is shared across languages')
  if ((body.nodeId || body.property) && (field.type !== 'pageTree' || !body.nodeId || !body.property)) {
    return badRequest('A node property reset requires a tree field, node and property')
  }

  return serializeCollabAwareWrite(async () => {
    const response = await db.transaction(async (tx) => {
      const row = await getDataRow(tx, current.id, current.localeId)
      const source = await getDataRow(tx, current.id, sourceLocale.id)
      if (!row || !source) return jsonResponse({ error: 'Data row not found' }, { status: 404 })
      const cells = structuredClone(row.localization?.cells ?? {})
      const translationMeta = structuredClone(row.localization?.translationMeta ?? {})
      if (body.action === 'reset') {
        if (body.nodeId && body.property) {
          const tree = parseLocaleTreeCell(cells[body.fieldId], body.fieldId)
          const nodes = resetLocalizedNodeProperty(tree.nodes, body.nodeId, body.property)
          if (Object.keys(nodes).length > 0) cells[body.fieldId] = { nodes }
          else delete cells[body.fieldId]
        } else {
          delete cells[body.fieldId]
        }
        delete translationMeta[body.fieldId]
      } else {
        if (!Object.hasOwn(cells, body.fieldId)) return badRequest('Inherited content does not need translation review')
        translationMeta[body.fieldId] = createTranslationFieldMetadata(source.cells[body.fieldId], 'reviewed')
      }
      await saveContentLocalizationDraft(tx, row.id, row.localeId, {
        cells, translationMeta,
        slug: body.action === 'reset' && body.fieldId === 'slug' ? source.slug : row.slug,
      }, user.id)
      await createAuditEvent(tx, {
        actorUserId: user.id, action: body.action === 'reset' ? 'translation.reset' : 'translation.review',
        targetType: 'data_row', targetId: row.id,
        metadata: { localeId: row.localeId, fieldId: body.fieldId, nodeId: body.nodeId ?? null, property: body.property ?? null },
        ...requestAuditContext(req),
      })
      return jsonResponse({ row: await getDataRow(tx, row.id, row.localeId) })
    })
    if (response.ok) notifyRowWrite({ tableId: current.tableId, rowIds: [current.id], kind: 'update', localeId: current.localeId, sharedChanged: false })
    return response
  })
}
