import type { DbClient } from '../../db/client'
import type { BranchScope } from '../../branches/scope'
import { canReadDataRow, canReadTable, canSeeAllDataRows, type DataAccessUser } from '../../auth/dataAccess'
import { userHasCapability } from '../../auth/authz'
import { findUserById, type AuthUser } from '../users'
import { getDraftSite } from '../site'
import { getDataTable, listDataTables } from './tables'
import { listDataRows } from './rows/read'
import { hasLocalizedDataFields, localizedDataReferences, assertLocalizedDataReferenceAccess, type DataLocalizationContext } from '@core/data/localizedCells'
import { physicalId } from '@core/branches'
import type { SiteDocument } from '@core/page-tree'
import type { DataField, DataRowCells, DataTable, DataLocalization } from '@core/data/schemas'
import { canonicalLanguage, LocalizationError, resolveSiteLanguage, resolveTranslation, translationKeys } from '@core/localization'
import type { SiteBundle, ImportStrategy } from '@core/data/bundleSchema'
import type { TranslationMessages } from '@core/localization-schema'

/** The same readable-table and own/any-row policy owns every catalogue projection. */
export async function readableLocalizedDataKeys(db: DbClient, scope: BranchScope, user: DataAccessUser, tables?: readonly DataTable[]): Promise<Set<string>> {
  const keys = new Set<string>()
  const readableTables = (tables ?? await listDataTables(db, scope)).filter(table => canReadTable(user, table) && hasLocalizedDataFields(table.fields))
  for (const table of readableTables) {
    const rows = await listDataRows(db, scope, table.id, canSeeAllDataRows(user) ? {} : { ownerUserId: user.id })
    for (const row of rows) {
      if (!canReadDataRow(user, row)) continue
      for (const key of localizedDataReferences(row.cells, table.fields, `rows.${row.id}.cells`).values()) keys.add(key)
      const { rows: versions } = await db<{ cells_json: DataRowCells }>`select cells_json from data_row_versions where row_id = ${physicalId(scope.branchId, row.id)}`
      for (const version of versions) {
        for (const key of localizedDataReferences(version.cells_json, table.fields, `rows.${row.id}.versions.cells`).values()) keys.add(key)
      }
    }
  }
  return keys
}

/** Copy only permitted text leaves; files, paths, unrelated config and source JSON never leave this boundary. */
function messagesForKeys(context: DataLocalizationContext, keys: ReadonlySet<string>): TranslationMessages {
  const messages: TranslationMessages = {}
  for (const key of keys) {
    const text = resolveTranslation(context.translations, key, context.language)
    const parts = key.split('.')
    let target = messages
    for (const part of parts.slice(0, -1)) {
      const value = Object.hasOwn(target, part) ? target[part] : undefined
      if (typeof value === 'string') throw new LocalizationError(`translations.${key}`, 'A translation path must address a text leaf')
      target = value ?? (target[part] = {})
    }
    target[parts.at(-1)!] = text
  }
  return messages
}

export async function readDataLocalization(db: DbClient, scope: BranchScope, user: DataAccessUser, tables: readonly DataTable[], language?: string): Promise<DataLocalization> {
  const shell = await getDraftSite(db, scope)
  if (!shell?.settings.localization) throw new LocalizationError('settings.localization', 'Configure language files to use localized data')
  const languages = shell.settings.localization.catalogues.map(catalogue => canonicalLanguage(catalogue.language))
  const canBrowseCatalogue = userHasCapability(user, 'site.read')
  if (language === undefined) return { languages, canBrowseCatalogue }
  const context = resolveSiteLanguage(shell, language)
  const keys = canBrowseCatalogue
    ? new Set(translationKeys(context.translations!))
    : await readableLocalizedDataKeys(db, scope, user, tables)
  return { languages, canBrowseCatalogue, language: context.language, translations: messagesForKeys(context, keys) }
}

/** The plugin host establishes table read access; this projection exposes only that table's references. */
export async function readPluginDataLocalization(db: DbClient, scope: BranchScope, table: DataTable, language?: string): Promise<DataLocalization> {
  const shell = await getDraftSite(db, scope)
  if (!shell?.settings.localization) throw new LocalizationError('settings.localization', 'Configure language files to use localized data')
  const languages = shell.settings.localization.catalogues.map(catalogue => canonicalLanguage(catalogue.language))
  if (language === undefined) return { languages, canBrowseCatalogue: false }
  const context = resolveSiteLanguage(shell, language)
  const keys = new Set<string>()
  for (const row of await listDataRows(db, scope, table.id)) {
    for (const key of localizedDataReferences(row.cells, table.fields, `rows.${row.id}.cells`).values()) keys.add(key)
  }
  return { languages, canBrowseCatalogue: false, language: context.language, translations: messagesForKeys(context, keys) }
}

/** Every repository writer validates references before persistence, including bulk and Y-document writes. */
export async function assertLocalizedDataRowWrite(db: DbClient, scope: BranchScope, tableId: string, cells: DataRowCells, actorUserId: string | null, pluginActorId: string | null, path: string): Promise<void> {
  const table = await getDataTable(db, scope, tableId)
  if (!table || !hasLocalizedDataFields(table.fields)) return
  await assertLocalizedDataWrite(db, scope, table.fields, cells, actorUserId, pluginActorId ? table.id : null, path)
}

/** Moving a row reclassifies its draft and every retained version under the target schema. */
export async function assertLocalizedDataRowMove(db: DbClient, scope: BranchScope, tableId: string, rowId: string, cells: DataRowCells, actorUserId: string | null, pluginActorId: string | null, path: string): Promise<void> {
  const table = await getDataTable(db, scope, tableId)
  if (!table || !hasLocalizedDataFields(table.fields)) return
  await assertLocalizedDataWrite(db, scope, table.fields, cells, actorUserId, pluginActorId ? table.id : null, path)
  const { rows: versions } = await db<{ cells_json: DataRowCells }>`select cells_json from data_row_versions where row_id = ${physicalId(scope.branchId, rowId)}`
  for (const version of versions) {
    await assertLocalizedDataWrite(db, scope, table.fields, version.cells_json, actorUserId, pluginActorId ? table.id : null, path)
  }
}

/** One validation owner for row writes, schema changes and import preflight. */
export async function assertLocalizedDataWrite(db: DbClient, scope: BranchScope, fields: readonly DataField[], cells: DataRowCells, actorUserId: string | null, pluginTableId: string | null, path: string, site?: Pick<SiteDocument, 'settings' | 'files'>): Promise<void> {
  const references = localizedDataReferences(cells, fields, path)
  if (references.size === 0) return
  if (actorUserId) {
    const user = await findUserById(db, actorUserId)
    if (!user) throw new LocalizationError(path, 'The content author could not be resolved')
    return assertLocalizedDataPrincipalWrite(db, scope, fields, cells, user, path, site)
  } else if (pluginTableId) {
    // Content plugins cannot browse private language files. They may reuse
    // references already present in their authorized target table.
    const keys = new Set<string>()
    const table = await getDataTable(db, scope, pluginTableId)
    if (!table) throw new LocalizationError(path, 'The authorized plugin table could not be resolved')
    for (const row of await listDataRows(db, scope, table.id)) {
      for (const key of localizedDataReferences(row.cells, table.fields, `rows.${row.id}.cells`).values()) keys.add(key)
    }
    assertLocalizedDataReferenceAccess(cells, fields, keys, path)
  }

  await assertLocalizedDataCatalogueReferences(db, scope, references, site)
}

/** Delegated tools validate their own principal before browser relay can use the owner's session. */
export async function assertLocalizedDataPrincipalWrite(db: DbClient, scope: BranchScope, fields: readonly DataField[], cells: DataRowCells, user: DataAccessUser, path: string, site?: Pick<SiteDocument, 'settings' | 'files'>): Promise<void> {
  const references = localizedDataReferences(cells, fields, path)
  if (references.size === 0) return
  if (!userHasCapability(user, 'site.read')) {
    assertLocalizedDataReferenceAccess(cells, fields, await readableLocalizedDataKeys(db, scope, user), path)
  }
  await assertLocalizedDataCatalogueReferences(db, scope, references, site)
}

async function assertLocalizedDataCatalogueReferences(db: DbClient, scope: BranchScope, references: ReadonlyMap<string, string>, site?: Pick<SiteDocument, 'settings' | 'files'>): Promise<void> {
  const shell = site ?? await getDraftSite(db, scope)
  if (!shell?.settings.localization) throw new LocalizationError('settings.localization', 'Configure language files to use localized data')
  for (const catalogue of shell.settings.localization.catalogues) {
    const context = resolveSiteLanguage(shell, catalogue.language)
    for (const [referencePath, key] of references) {
      try { resolveTranslation(context.translations, key, context.language) }
      catch (cause) { throw new LocalizationError(referencePath, 'The referenced language-catalogue text is missing or invalid', cause) }
    }
  }
}

async function assertLocalizedDataHistory(db: DbClient, scope: BranchScope, rowId: string, fields: readonly DataField[], userId: string, path: string, site?: Pick<SiteDocument, 'settings' | 'files'>): Promise<void> {
  const { rows: versions } = await db<{ cells_json: DataRowCells }>`select cells_json from data_row_versions where row_id = ${physicalId(scope.branchId, rowId)}`
  for (const version of versions) {
    await assertLocalizedDataWrite(db, scope, fields, version.cells_json, userId, null, path, site)
  }
}

/** A schema change also reclassifies historical cells; validate both before exposing their text. */
export async function assertLocalizedDataTableWrite(db: DbClient, scope: BranchScope, tableId: string, fields: readonly DataField[], user: DataAccessUser): Promise<void> {
  if (!hasLocalizedDataFields(fields)) return
  // Schema management does not grant access to private row identities.
  const path = `tables.${tableId}.fields`
  for (const row of await listDataRows(db, scope, tableId)) {
    await assertLocalizedDataWrite(db, scope, fields, row.cells, user.id, null, path)
    await assertLocalizedDataHistory(db, scope, row.id, fields, user.id, path)
  }
}

/** Validate the final imported schema and references before any transaction can write or wipe data. */
export async function assertLocalizedDataImport(db: DbClient, scope: BranchScope, user: AuthUser, bundle: SiteBundle, strategy: ImportStrategy): Promise<void> {
  const existing = await listDataTables(db, scope)
  const tables = new Map(existing.filter(table => strategy !== 'replace' || table.system).map(table => [table.id, table]))
  for (const table of bundle.tables) {
    if (strategy !== 'merge-add' || !tables.has(table.id)) tables.set(table.id, table)
  }
  const existingRows = new Map<string, Awaited<ReturnType<typeof listDataRows>>[number]>()
  if (strategy !== 'replace') {
    for (const table of existing) {
      for (const row of await listDataRows(db, scope, table.id)) existingRows.set(row.id, row)
    }
  }
  const site = strategy === 'merge-add' ? undefined : bundle.site
  const incomingIds = new Set(bundle.rows.map(row => row.id))
  for (const row of bundle.rows) {
    if (strategy === 'merge-add' && existingRows.has(row.id)) continue
    const table = tables.get(row.tableId)
    if (!table) throw new LocalizationError(`rows.${row.id}.tableId`, 'The imported data table is missing')
    await assertLocalizedDataWrite(db, scope, table.fields, row.cells, user.id, null, `tables.${table.id}.cells`, site)
  }
  for (const row of existingRows.values()) {
    const incoming = strategy === 'merge-overwrite' ? bundle.rows.find(candidate => candidate.id === row.id) : undefined
    const table = tables.get(incoming?.tableId ?? row.tableId)
    if (!table) throw new LocalizationError('tables', 'The retained data table is missing')
    const path = `tables.${table.id}.fields`
    if (strategy !== 'merge-overwrite' || !incomingIds.has(row.id)) {
      await assertLocalizedDataWrite(db, scope, table.fields, row.cells, user.id, null, path, site)
    }
    await assertLocalizedDataHistory(db, scope, row.id, table.fields, user.id, path, site)
  }
}
