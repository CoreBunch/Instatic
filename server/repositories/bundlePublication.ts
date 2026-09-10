/** Portable localization state and immutable publication dependencies. */
import {
  BundleRuntimeAssetSchema,
  BundleSiteSnapshotSchema,
  BundleVersionSchema,
  type ImportStrategy,
  type SiteBundle,
} from '@core/data/bundleSchema'
import { parseValue, Type } from '@core/utils/typeboxHelpers'
import { isoDate } from '@core/utils/isoDate'
import { deepEqual } from '@core/utils/deepEqual'
import { createPublishedRouteInventory } from '@core/localization-routing'
import { placeholder, type DbClient } from '../db/client'
import {
  importLocale,
  listContentLocalizations,
  listLocales,
  listTableLocalizations,
  LocalizationError,
  saveContentLocalizationDraft,
  saveTableLocalization,
} from './localization'
import { listPublishedRouteCandidates } from './localizationRoutes'

export type BundlePublication = Pick<SiteBundle,
  'locales' | 'localizations' | 'tableLocalizations' | 'versions' | 'siteSnapshots' | 'runtimeAssets'>

export async function exportBundlePublication(
  db: DbClient,
  rowIds: readonly string[],
  tableIds: readonly string[],
  includeReleases = true,
): Promise<BundlePublication> {
  const [locales, localizations, tableLocalizations] = await Promise.all([
    listLocales(db),
    listContentLocalizations(db, { rowIds }),
    listTableLocalizations(db),
  ])
  const result: BundlePublication = {
    locales,
    localizations: includeReleases ? localizations : localizations.map((variant) => ({
      ...variant, availability: 'offline', activeVersionId: null,
      scheduledPublishAt: null, scheduledRevision: null,
      publishedAt: null, publishedByUserId: null,
    })),
    tableLocalizations: tableLocalizations.filter((entry) => tableIds.includes(entry.tableId)),
    versions: [], siteSnapshots: [], runtimeAssets: [],
  }
  if (!includeReleases || rowIds.length === 0) return result
  const slots = rowIds.map((_, index) => placeholder(db.dialect, index + 1)).join(', ')
  const { rows: versions } = await db.unsafe<{
    id: string; row_id: string; locale_id: string; version_number: number;
    cells_json: unknown; slug: string; public_path: string | null; site_snapshot_id: string | null;
    runtime_assets_json: unknown; published_by_user_id: string | null;
    published_at: string | Date; created_at: string | Date;
  }>(`select * from data_row_versions where row_id in (${slots}) order by row_id, version_number`, [...rowIds])
  result.versions = versions.map((version) => parseValue(BundleVersionSchema, {
    id: version.id, rowId: version.row_id, localeId: version.locale_id,
    versionNumber: Number(version.version_number), cells: version.cells_json,
    slug: version.slug, publicPath: version.public_path, siteSnapshotId: version.site_snapshot_id,
    runtimeAssets: version.runtime_assets_json,
    publishedByUserId: version.published_by_user_id,
    publishedAt: isoDate(version.published_at), createdAt: isoDate(version.created_at),
  }))
  const snapshotIds = [...new Set([
    ...versions.flatMap((version) => version.site_snapshot_id ? [version.site_snapshot_id] : []),
    ...localizations.flatMap((variant) => variant.scheduledRevision?.siteSnapshotId ? [variant.scheduledRevision.siteSnapshotId] : []),
  ])]
  if (snapshotIds.length > 0) {
    const { rows } = await db.unsafe<{ id: string; site_json: unknown; content_hash: string; importmap_body: string | null; importmap_sha256: string | null; created_at: string | Date }>(
      `select * from site_snapshots where id in (${snapshotIds.map((_, index) => placeholder(db.dialect, index + 1)).join(', ')}) order by id`, snapshotIds,
    )
    result.siteSnapshots = rows.map((row) => parseValue(BundleSiteSnapshotSchema, {
      id: row.id, site: row.site_json, contentHash: row.content_hash,
      importmapBody: row.importmap_body, importmapSha256: row.importmap_sha256, createdAt: isoDate(row.created_at),
    }))
  }
  const { rows: assets } = await db.unsafe<{ id: string; data_row_version_id: string; asset_path: string; public_path: string; content_type: string; content_bytes: Uint8Array; created_at: string | Date }>(`
    select assets.* from published_runtime_assets assets
    join data_row_versions versions on versions.id = assets.data_row_version_id
    where versions.row_id in (${slots}) order by assets.id`, [...rowIds])
  result.runtimeAssets = assets.map((asset) => parseValue(BundleRuntimeAssetSchema, {
    id: asset.id, dataRowVersionId: asset.data_row_version_id, assetPath: asset.asset_path,
    publicPath: asset.public_path, contentType: asset.content_type,
    bytesBase64: Buffer.from(asset.content_bytes).toString('base64'), createdAt: isoDate(asset.created_at),
  }))
  return result
}

/** Keep logical locale identities stable; merges never silently relabel existing content. */
export async function restoreBundleLocales(db: DbClient, bundle: SiteBundle, strategy: ImportStrategy): Promise<void> {
  if (!bundle.locales) return
  if (bundle.locales.filter((locale) => locale.isDefault).length !== 1 || !bundle.locales.some((locale) => locale.id === 'default' && locale.isDefault)) {
    throw new LocalizationError('A bundle must contain exactly one default language with identity "default"', 'locales')
  }
  for (const locale of bundle.locales) await importLocale(db, locale, strategy)
}

/** Called in the same transaction as the imported logical rows. */
export async function restoreBundlePublication(
  db: DbClient,
  bundle: SiteBundle,
  importedRowIds: ReadonlySet<string>,
  importedTableIds: ReadonlySet<string>,
  strategy: ImportStrategy,
): Promise<void> {
  for (const entry of bundle.tableLocalizations ?? []) {
    if (!importedTableIds.has(entry.tableId)) continue
    if (strategy === 'merge-add' && (await listTableLocalizations(db, entry.tableId)).some((stored) => stored.localeId === entry.localeId)) continue
    await saveTableLocalization(db, entry.tableId, entry.localeId, entry.routeBase)
  }
  if (bundle.localizations !== undefined) {
    for (const rowId of importedRowIds) await db`delete from data_row_localizations where row_id = ${rowId}`
  }
  const versions = (bundle.versions ?? []).filter((version) => importedRowIds.has(version.rowId))
  const variants = (bundle.localizations ?? []).filter((variant) => importedRowIds.has(variant.rowId))
  const snapshotIds = new Set([
    ...versions.flatMap((version) => version.siteSnapshotId ? [version.siteSnapshotId] : []),
    ...variants.flatMap((variant) => variant.scheduledRevision?.siteSnapshotId ? [variant.scheduledRevision.siteSnapshotId] : []),
  ])
  const snapshots = (bundle.siteSnapshots ?? []).filter((snapshot) => snapshotIds.has(snapshot.id))
  const incomingSnapshots = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]))
  for (const version of versions) {
    if (version.siteSnapshotId && !incomingSnapshots.has(version.siteSnapshotId)) {
      throw new LocalizationError('A published version is missing its immutable site snapshot', 'versions')
    }
  }
  for (const snapshot of snapshots) {
    const { rows } = await db<{ site_json: unknown; content_hash: string; importmap_body: string | null; importmap_sha256: string | null }>`select site_json, content_hash, importmap_body, importmap_sha256 from site_snapshots where id = ${snapshot.id}`
    if (rows[0]) {
      const stored = rows[0]
      if (!deepEqual(stored.site_json, snapshot.site) || stored.content_hash !== snapshot.contentHash || stored.importmap_body !== snapshot.importmapBody || stored.importmap_sha256 !== snapshot.importmapSha256) {
        throw new LocalizationError('A site snapshot identity already belongs to different immutable content', 'siteSnapshots')
      }
    } else {
      await db`insert into site_snapshots (id, site_json, content_hash, importmap_body, importmap_sha256, created_at)
        values (${snapshot.id}, ${snapshot.site}, ${snapshot.contentHash}, ${snapshot.importmapBody}, ${snapshot.importmapSha256}, ${snapshot.createdAt})`
    }
  }
  const incomingVersions = new Map(versions.map((version) => [version.id, version]))
  for (const version of versions) {
    const { rows } = await db<{ row_id: string; locale_id: string; version_number: number; cells_json: unknown; slug: string; public_path: string | null; site_snapshot_id: string | null; runtime_assets_json: unknown }>`select * from data_row_versions where id = ${version.id}`
    if (rows[0]) {
      const stored = rows[0]
      if (stored.row_id !== version.rowId || stored.locale_id !== version.localeId || Number(stored.version_number) !== version.versionNumber || !deepEqual(stored.cells_json, version.cells) || stored.slug !== version.slug || stored.public_path !== version.publicPath || stored.site_snapshot_id !== version.siteSnapshotId || !deepEqual(stored.runtime_assets_json, version.runtimeAssets)) {
        throw new LocalizationError('A version identity already belongs to different immutable content', 'versions')
      }
      continue
    }
    const { rows: collisions } = await db`select id from data_row_versions where row_id = ${version.rowId} and version_number = ${version.versionNumber}`
    if (collisions[0]) throw new LocalizationError('Version history conflicts with local history; use replace to restore this bundle', 'versions')
    await db`insert into data_row_versions (id, row_id, locale_id, version_number, cells_json, slug, public_path, site_snapshot_id, runtime_assets_json, published_at, created_at)
      values (${version.id}, ${version.rowId}, ${version.localeId}, ${version.versionNumber}, ${version.cells}, ${version.slug}, ${version.publicPath}, ${version.siteSnapshotId}, ${version.runtimeAssets}, ${version.publishedAt}, ${version.createdAt})`
  }
  for (const asset of bundle.runtimeAssets ?? []) {
    if (!incomingVersions.has(asset.dataRowVersionId)) continue
    const { rows } = await db<{ id: string; data_row_version_id: string; asset_path: string; public_path: string; content_type: string; content_bytes: Uint8Array }>`select * from published_runtime_assets where id = ${asset.id} or public_path = ${asset.publicPath}`
    const bytes = Buffer.from(asset.bytesBase64, 'base64')
    if (rows[0]) {
      const stored = rows[0]
      if (stored.id !== asset.id || stored.data_row_version_id !== asset.dataRowVersionId || stored.asset_path !== asset.assetPath || stored.public_path !== asset.publicPath || stored.content_type !== asset.contentType || !Buffer.from(stored.content_bytes).equals(bytes)) {
        throw new LocalizationError('A runtime asset identity already belongs to different immutable bytes', 'runtimeAssets')
      }
    } else {
      await db`insert into published_runtime_assets (id, data_row_version_id, asset_path, public_path, content_type, content_bytes, created_at)
        values (${asset.id}, ${asset.dataRowVersionId}, ${asset.assetPath}, ${asset.publicPath}, ${asset.contentType}, ${bytes}, ${asset.createdAt})`
    }
  }
  for (const variant of variants) {
    const active = variant.activeVersionId ? incomingVersions.get(variant.activeVersionId) : null
    if (variant.activeVersionId && (!active || active.rowId !== variant.rowId || active.localeId !== variant.localeId)) {
      throw new LocalizationError('A language variant references a missing or mismatched published version', 'localizations')
    }
    const row = bundle.rows.find((entry) => entry.id === variant.rowId)
    const kind = bundle.tables.find((entry) => entry.id === row?.tableId)?.kind
    if (variant.availability === 'online' && (!active || (kind === 'page' && !active.siteSnapshotId))) {
      throw new LocalizationError('An online page requires its complete immutable release', 'localizations')
    }
    if (active?.siteSnapshotId && kind === 'page') {
      const snapshot = incomingSnapshots.get(active.siteSnapshotId)!
      const pages = parseValue(Type.Array(Type.Object({ id: Type.String() })), snapshot.site.pages)
      if (!pages.some((page) => page.id === variant.rowId) || (snapshot.site.localeId !== undefined && snapshot.site.localeId !== variant.localeId) || (snapshot.site.localeId === undefined && variant.localeId !== 'default')) {
        throw new LocalizationError('A published page points to a snapshot for another page or language', 'siteSnapshots')
      }
    }
    if (variant.scheduledRevision?.siteSnapshotId && !incomingSnapshots.has(variant.scheduledRevision.siteSnapshotId)) {
      throw new LocalizationError('A scheduled publication is missing its frozen site snapshot', 'localizations')
    }
    await saveContentLocalizationDraft(db, variant.rowId, variant.localeId, variant)
    await db`update data_row_localizations
      set availability = ${variant.availability}, active_version_id = ${variant.activeVersionId},
          scheduled_publish_at = ${variant.scheduledPublishAt}, scheduled_revision_json = ${variant.scheduledRevision},
          seq = ${variant.seq}, created_at = ${variant.createdAt}, updated_at = ${variant.updatedAt}, published_at = ${variant.publishedAt},
          created_by_user_id = null, updated_by_user_id = null, published_by_user_id = null
      where row_id = ${variant.rowId} and locale_id = ${variant.localeId}`
  }
  // Frozen public paths remain unique across imported and retained live content.
  createPublishedRouteInventory(await listLocales(db), await listPublishedRouteCandidates(db))
}
