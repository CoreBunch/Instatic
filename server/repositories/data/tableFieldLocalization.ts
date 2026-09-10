import type { DataField, DataRowCells, DataTable } from '@core/data/schemas'
import { materializeLocalizedCells, resolveDataFieldLocalization } from '@core/localization'
import type { DbClient } from '../../db/client'
import { getContentLocalization, getDefaultLocale, saveContentLocalizationDraft } from '../localization'

/** Preserve the source value when a field switches between shared and translated authoring. */
export async function changeTableFieldLocalizationInTx(
  db: DbClient,
  table: DataTable,
  nextFields: readonly DataField[],
  actorUserId: string | null,
): Promise<void> {
  const changed = nextFields.filter((field) => {
    const before = table.fields.find((candidate) => candidate.id === field.id)
    return before && resolveDataFieldLocalization(before) !== resolveDataFieldLocalization(field)
  })
  if (changed.length === 0) return
  const { rows } = await db<{ id: string; cells_json: DataRowCells }>`
    select id, cells_json from data_rows where table_id = ${table.id}
  `
  for (const row of rows) await changeRowFieldLocalizationInTx(db, row, table.fields, nextFields, actorUserId)
}

/** A collection move uses the same value-preserving transfer as schema editing. */
export async function changeRowFieldLocalizationInTx(
  db: DbClient,
  row: { id: string; cells_json: DataRowCells },
  previousFields: readonly DataField[],
  nextFields: readonly DataField[],
  actorUserId: string | null,
): Promise<void> {
  const changed = nextFields.filter((field) => {
    const before = previousFields.find((candidate) => candidate.id === field.id)
    return before && resolveDataFieldLocalization(before) !== resolveDataFieldLocalization(field)
  })
  if (changed.length === 0) return
  const source = await getDefaultLocale(db)
  const localization = await getContentLocalization(db, row.id, source.id)
  const shared = structuredClone(row.cells_json)
  const cells = structuredClone(localization?.cells ?? {})
  const projection = materializeLocalizedCells(previousFields, shared, cells, cells)
  for (const field of changed) {
    const destination = resolveDataFieldLocalization(field) === 'shared' ? shared : cells
    if (field.type === 'pageTree' && resolveDataFieldLocalization(field) === 'localized') {
      // The shared tree is already the source baseline; locale values are sparse overlays.
      delete cells[field.id]
    } else if (Object.hasOwn(projection, field.id)) {
      Object.defineProperty(destination, field.id, { value: projection[field.id], writable: true, configurable: true, enumerable: true })
    } else {
      delete destination[field.id]
    }
  }
  await db`update data_rows set cells_json = ${shared}, updated_at = current_timestamp where id = ${row.id}`
  await saveContentLocalizationDraft(db, row.id, source.id, {
    cells, slug: localization?.slug ?? '', translationMeta: localization?.translationMeta ?? {},
  }, actorUserId)
}
