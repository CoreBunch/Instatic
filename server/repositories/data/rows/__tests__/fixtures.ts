import type { DbClient } from '../../../../db/client'
import type { DataRowCells, DataRowStatus } from '@core/data/schemas'

/** SQL fixture for the canonical draft and published-variant storage, independent of mutation helpers. */
export async function seedLocalizedVariant(
  db: DbClient,
  input: { rowId: string; cells: DataRowCells; slug: string; status?: DataRowStatus; localeId?: string; updatedAt?: string },
): Promise<void> {
  const localeId = input.localeId ?? 'default'
  const hasVersion = input.status === 'published' || input.status === 'unpublished'
  const versionId = hasVersion ? `${input.rowId}-${localeId}-version` : null
  if (versionId) {
    await db`
      insert into data_row_versions (id, row_id, locale_id, version_number, cells_json, slug, public_path)
      values (${versionId}, ${input.rowId}, ${localeId}, 1, ${input.cells}, ${input.slug}, ${`/posts/${input.slug}`})
    `
  }
  await db`
    insert into data_row_localizations (row_id, locale_id, cells_json, slug, availability, active_version_id, created_at, updated_at)
    values (${input.rowId}, ${localeId}, ${input.cells}, ${input.slug}, ${input.status === 'published' ? 'online' : 'offline'},
      ${versionId}, ${input.updatedAt ?? '2024-01-01T00:00:00.000Z'}, ${input.updatedAt ?? '2024-01-01T00:00:00.000Z'})
  `
}
