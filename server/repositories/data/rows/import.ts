/** Bundle restoration writes logical identity and locale drafts; live pointers must reference real snapshots. */
import type { DbClient } from '../../../db/client'
import type { ContentLocalizationDraftInput } from '@core/localization-schema'
import type { DataRowCells, DataRowStatus } from '@core/data/schemas'
import { resolveDataFieldLocalization } from '@core/localization'
import { getDataTable } from '../tables'
import { getDefaultLocale, getLocale, LocalizationError, saveContentLocalizationDraft, setContentLocalizationAvailability, setContentLocalizationPublishedVersion } from '../../localization'

export interface DataRowImportInput {
  id: string
  tableId: string
  cells: DataRowCells
  sharedCells?: DataRowCells
  localeId?: string
  localization?: ContentLocalizationDraftInput | null
  activeVersionId?: string | null
  slug: string
  status: DataRowStatus
  publishedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

async function importProjection(db: DbClient, input: DataRowImportInput) {
  const locale = input.localeId ? await getLocale(db, input.localeId) : await getDefaultLocale(db)
  if (!locale) throw new LocalizationError('Unknown imported content language', 'localeId')
  const table = await getDataTable(db, input.tableId)
  if (!table) throw new Error('Imported content table is missing')
  const sharedCells = structuredClone(input.sharedCells ?? input.cells)
  const cells: DataRowCells = {}
  for (const field of table.fields) {
    if (resolveDataFieldLocalization(field) === 'shared' || field.type === 'pageTree') continue
    if (Object.hasOwn(input.cells, field.id)) cells[field.id] = structuredClone(input.cells[field.id])
    delete sharedCells[field.id]
  }
  return { locale, sharedCells, cells }
}

async function restoreDraft(db: DbClient, input: DataRowImportInput, localeId: string, cells: DataRowCells): Promise<void> {
  if (input.localization === null) return
  await saveContentLocalizationDraft(db, input.id, localeId, input.localization ?? { cells, slug: input.slug })
  await setContentLocalizationAvailability(db, input.id, localeId, 'offline')
  if (input.status === 'published' && input.activeVersionId) {
    await setContentLocalizationPublishedVersion(db, input.id, localeId, input.activeVersionId)
  }
  // The complete bundle restores every locale and its history after logical rows exist.
  await db`
    update data_row_localizations
    set created_at = ${input.createdAt ?? new Date().toISOString()},
        updated_at = ${input.updatedAt ?? new Date().toISOString()}
    where row_id = ${input.id} and locale_id = ${localeId}
  `
}

export async function upsertDataRow(db: DbClient, input: DataRowImportInput): Promise<void> {
  const projection = await importProjection(db, input)
  await db`
    insert into data_rows (id, table_id, cells_json, slug, created_at, updated_at)
    values (${input.id}, ${input.tableId}, ${projection.sharedCells}, '', ${input.createdAt ?? new Date().toISOString()}, ${input.updatedAt ?? new Date().toISOString()})
    on conflict (id) do update set table_id = excluded.table_id, cells_json = excluded.cells_json,
      slug = '', updated_at = excluded.updated_at
  `
  await restoreDraft(db, input, projection.locale.id, projection.cells)
}

/** Skip existing identities or an authored slug already claimed in the selected language. */
export async function insertDataRowIfAbsent(db: DbClient, input: DataRowImportInput): Promise<boolean> {
  const projection = await importProjection(db, input)
  const { rows } = await db<{ id: string }>`
    insert into data_rows (id, table_id, cells_json, slug, created_at, updated_at)
    select ${input.id}, ${input.tableId}, ${projection.sharedCells}, '', ${input.createdAt ?? new Date().toISOString()}, ${input.updatedAt ?? new Date().toISOString()}
    where not exists (
      select 1 from data_row_localizations localized join data_rows on data_rows.id = localized.row_id
      where data_rows.table_id = ${input.tableId} and data_rows.deleted_at is null
        and localized.locale_id = ${projection.locale.id} and localized.slug = ${input.slug} and localized.slug <> ''
    )
    on conflict do nothing returning id
  `
  if (!rows[0]) return false
  await restoreDraft(db, input, projection.locale.id, projection.cells)
  return true
}

export async function replaceDataRow(db: DbClient, input: DataRowImportInput): Promise<void> {
  const projection = await importProjection(db, input)
  await db`
    insert into data_rows (id, table_id, cells_json, slug, created_at, updated_at)
    values (${input.id}, ${input.tableId}, ${projection.sharedCells}, '', ${input.createdAt ?? new Date().toISOString()}, ${input.updatedAt ?? new Date().toISOString()})
  `
  await restoreDraft(db, input, projection.locale.id, projection.cells)
}
