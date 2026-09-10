/**
 * Data access for published data rows.
 *
 *   persistDataRowPublish         — transactional write of one row publish:
 *                                   append a new data_row_versions row, flip
 *                                   the row to `published`, write
 *                                   `active_version_id`, and (when the slug
 *                                   changed) record a redirect from the
 *                                   previous public path
 *   getPublishedDataRowByRoute    — resolve a public URL to the active
 *                                   published version of a row; resolves
 *                                   `featuredMediaPath` via a second query
 *                                   against `media_assets` (app code reads the
 *                                   cell value — SQL stays dialect-naive)
 *   getDataRowRedirectByRoute     — resolve a public URL to a redirect target
 *                                   when the URL belongs to a
 *                                   previously-published slug
 *   listPublishedRowRoutes        — every published row route (for the bake)
 *   getRowTableRouteInfo          — route base + table slug for one row
 *   getRowTableRouteBase          — route base only, ignoring soft deletes
 *
 * Data access ONLY. The row-publish orchestration (publish lock, Layer A
 * artefact writes, cache bump) lives in `server/publish/publishRow.ts` and
 * calls down into this repository.
 */
import type { BundleRedirect } from '@core/data/bundleSchema'
import { nanoid } from 'nanoid'
import { placeholder, type DbClient } from '../../db/client'
import { userRefColumns, userRefJoin } from './shared'
import type { DataRow, DataRowVersion, DataRowRedirect, PublishedDataRow } from '@core/data/schemas'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { readFeaturedMediaCell } from '@core/data/cells'
import { getDataRow } from './rows'
import { getDefaultLocale, setContentLocalizationPublishedVersion } from '../localization'
import type { ScheduledLocalizationRevision } from '@core/localization-schema'
import { nextDataRowVersionNumber } from './versions'
import { isoDate } from '@core/utils/isoDate'

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface PublishedDataRowQueryRow {
  id: string
  row_id: string
  table_id: string
  table_slug: string
  table_kind: string
  table_route_base: string
  locale_id: string
  public_path: string | null
  site_snapshot_id: string | null
  version_number: number
  cells_json: Record<string, unknown>
  slug: string
  author_user_id?: string | null
  author_display_name?: string | null
  author_role_slug?: string | null
  author_role_name?: string | null
  published_by_user_id?: string | null
  published_by_display_name?: string | null
  published_by_role_slug?: string | null
  published_by_role_name?: string | null
  published_at: string | Date
  created_at: string | Date
}

interface DataRowRedirectRow {
  id: string
  from_route_base: string
  from_slug: string
  target_path: string
}

interface MediaAssetRow {
  public_path: string | null
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The public route a row's previously-published version was served under. */
export interface PreviousPublishedRoute {
  slug: string
  routeBase: string
  path: string
  localeId: string
}

export interface PersistDataRowPublishResult {
  row: DataRow
  version: DataRowVersion
  /**
   * The route of the version that was active BEFORE this publish, or `null`
   * on a first publish. The orchestrator uses it to prune the stale Layer A
   * artefact when the slug changed.
   */
  previousRoute: PreviousPublishedRoute | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Public URL path for a row: `<normalized route base>/<slug>`. */
export function publicDataPath(routeBase: string, slug: string): string {
  const normalizedBase = normalizeRouteBase(routeBase)
  return `${normalizedBase === '/' ? '' : normalizedBase}/${slug}`
}

// ---------------------------------------------------------------------------
// Publish persistence
// ---------------------------------------------------------------------------

/**
 * Transactional write of one row publish. DB writes only — the publish lock,
 * artefact bake, and cache bump are owned by `server/publish/publishRow.ts`.
 */
export interface PersistDataRowPublishOptions {
  localeId: string
  publicPath: string | null
  siteSnapshotId: string | null
  revision?: ScheduledLocalizationRevision
}

export async function persistDataRowPublish(
  db: DbClient,
  rowId: string,
  publisherUserId: string | null,
  options: PersistDataRowPublishOptions,
): Promise<PersistDataRowPublishResult> {
  return db.transaction(async (tx) => {
    const draft = await getDataRow(tx, rowId, options.localeId)
    if (!draft) throw new Error('Content item not found')
    const cells = options.revision?.cells ?? draft.cells
    const slug = options.revision?.slug ?? draft.slug
    const previousRoute = await readPreviousPublishedRoute(tx, rowId, options.localeId)
    const versionNumber = await nextDataRowVersionNumber(tx, rowId)
    const versionId = nanoid()
    await tx`
      insert into data_row_versions
        (id, row_id, locale_id, version_number, cells_json, slug, public_path, site_snapshot_id, published_by_user_id)
      values (${versionId}, ${rowId}, ${options.localeId}, ${versionNumber}, ${cells}, ${slug},
              ${options.publicPath}, ${options.siteSnapshotId}, ${publisherUserId})
    `
    await tx`
      insert into data_row_localizations (row_id, locale_id, slug)
      values (${rowId}, ${options.localeId}, ${slug})
      on conflict (row_id, locale_id) do nothing
    `
    const localization = await setContentLocalizationPublishedVersion(tx, rowId, options.localeId, versionId, publisherUserId)
    if (!localization) throw new Error('Content item disappeared during publication')
    if (previousRoute && options.publicPath !== previousRoute.path) {
      await savePublishedRedirect(tx, rowId, draft.tableId, options.localeId, previousRoute.path)
    }
    const row = await getDataRow(tx, rowId, options.localeId)
    if (!row) throw new Error('Published content item could not be read')
    const publishedAt = localization.publishedAt ?? new Date().toISOString()
    return {
      row,
      version: {
        id: versionId, rowId, localeId: options.localeId, publicPath: options.publicPath,
        siteSnapshotId: options.siteSnapshotId, versionNumber, cells, slug,
        publishedByUserId: publisherUserId, publishedAt, createdAt: publishedAt,
      },
      previousRoute,
    }
  })
}

/** Reads the frozen route even after unpublishing or soft deletion. */
export async function readPreviousPublishedRoute(
  db: DbClient,
  rowId: string,
  localeId?: string,
): Promise<PreviousPublishedRoute | null> {
  const targetLocaleId = localeId ?? (await getDefaultLocale(db)).id
  const { rows } = await db<{ slug: string; public_path: string | null }>`
    select versions.slug, versions.public_path
    from data_row_localizations variants
    join data_row_versions versions on versions.id = variants.active_version_id
      and versions.row_id = variants.row_id and versions.locale_id = variants.locale_id
    where variants.row_id = ${rowId} and variants.locale_id = ${targetLocaleId}
    limit 1
  `
  const row = rows[0]
  if (!row?.public_path) return null
  const slash = row.public_path.lastIndexOf('/')
  return { slug: row.slug, routeBase: row.public_path.slice(0, slash) || '/', path: row.public_path, localeId: targetLocaleId }
}

export async function savePublishedRedirect(
  db: DbClient,
  rowId: string,
  tableId: string,
  localeId: string,
  previousPath: string,
): Promise<void> {
  const slash = previousPath.lastIndexOf('/')
  await db`
    insert into data_row_redirects (id, table_id, locale_id, from_route_base, from_slug, target_row_id)
    values (${nanoid()}, ${tableId}, ${localeId}, ${previousPath.slice(0, slash) || '/'}, ${previousPath.slice(slash + 1)}, ${rowId})
    on conflict (from_route_base, from_slug) do update
      set table_id = excluded.table_id, locale_id = excluded.locale_id, target_row_id = excluded.target_row_id
  `
}

// ---------------------------------------------------------------------------
// Route info lookups
// ---------------------------------------------------------------------------

/**
 * Fetch the `route_base` and `slug` of the `data_tables` row that owns
 * the given data row. Used by the artefact writer in
 * `server/publish/publishRow.ts` to resolve the public URL path without
 * joining the table into every other query.
 */
export async function getPublishedDataRowByRoute(
  db: DbClient,
  tableRouteBase: string,
  rowSlug: string,
  localeId?: string,
): Promise<PublishedDataRow | null> {
  return readPublishedDataRow(db, { localeId, publicPath: publicDataPath(tableRouteBase, rowSlug) })
}

export async function getPublishedDataRowById(
  db: DbClient,
  rowId: string,
  localeId?: string,
): Promise<PublishedDataRow | null> {
  return readPublishedDataRow(db, { localeId, rowId })
}

async function readPublishedDataRow(
  db: DbClient,
  options: { localeId?: string; rowId?: string; publicPath?: string },
): Promise<PublishedDataRow | null> {
  const localeId = options.localeId ?? (await getDefaultLocale(db)).id
  const p = (n: number) => placeholder(db.dialect, n)
  const where = options.rowId !== undefined ? `data_rows.id = ${p(2)}` : `data_row_versions.public_path = ${p(2)}`
  const { rows } = await db.unsafe<PublishedDataRowQueryRow>(
    `select data_row_versions.id, data_row_versions.row_id, data_row_versions.locale_id,
           data_row_versions.public_path, data_row_versions.site_snapshot_id,
           data_rows.table_id, data_tables.slug as table_slug, data_tables.kind as table_kind,
           data_tables.route_base as table_route_base,
           data_row_versions.version_number, data_row_versions.cells_json, data_row_versions.slug,
           data_rows.author_user_id, ${userRefColumns('author')},
           data_row_versions.published_by_user_id, ${userRefColumns('published_by')},
           data_row_versions.published_at, data_row_versions.created_at
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    join data_row_localizations variants on variants.row_id = data_rows.id
    join data_row_versions on data_row_versions.id = variants.active_version_id
      and data_row_versions.row_id = variants.row_id and data_row_versions.locale_id = variants.locale_id
    join site_locales locales on locales.id = variants.locale_id
    ${userRefJoin('author', 'data_rows.author_user_id')}
    ${userRefJoin('published_by', 'data_row_versions.published_by_user_id')}
    where variants.locale_id = ${p(1)} and ${where}
      and variants.availability = 'online' and locales.enabled = ${p(3)}
      and data_rows.deleted_at is null and data_tables.deleted_at is null
    limit 1`,
    [localeId, options.rowId ?? options.publicPath, true],
  )

  if (!rows[0]) return null

  const queryRow = rows[0]
  const cells = queryRow.cells_json

  // Resolve featuredMediaPath in app code: read the cell value, then do a
  // second query only when a media id is present. This avoids any
  // dialect-specific JSON extraction in the primary query.
  const featuredMediaId = readFeaturedMediaCell(cells)
  let featuredMediaPath: string | null = null

  if (featuredMediaId) {
    const { rows: mediaRows } = await db<MediaAssetRow>`
      select public_path from media_assets
      where id = ${featuredMediaId}
      limit 1
    `
    featuredMediaPath = mediaRows[0]?.public_path ?? null
  }

  return {
    id: queryRow.id,
    rowId: queryRow.row_id,
    localeId: queryRow.locale_id,
    publicPath: queryRow.public_path,
    siteSnapshotId: queryRow.site_snapshot_id,
    tableId: queryRow.table_id,
    tableSlug: queryRow.table_slug,
    tableKind: queryRow.table_kind as PublishedDataRow['tableKind'],
    tableRouteBase: normalizeRouteBase(queryRow.table_route_base),
    versionNumber: Number(queryRow.version_number),
    cells,
    slug: queryRow.slug,
    featuredMediaId,
    featuredMediaPath,
    authorUserId: queryRow.author_user_id ?? null,
    authorName: queryRow.author_display_name ?? null,
    authorRoleSlug: queryRow.author_role_slug ?? null,
    authorRoleName: queryRow.author_role_name ?? null,
    publishedByUserId: queryRow.published_by_user_id ?? null,
    publishedByName: queryRow.published_by_display_name ?? null,
    publishedByRoleSlug: queryRow.published_by_role_slug ?? null,
    publishedByRoleName: queryRow.published_by_role_name ?? null,
    publishedAt: isoDate(queryRow.published_at),
    createdAt: isoDate(queryRow.created_at),
  }
}

export async function getDataRowRedirectByRoute(
  db: DbClient,
  tableRouteBase: string,
  rowSlug: string,
): Promise<DataRowRedirect | null> {
  return getPublishedRedirectByPath(db, publicDataPath(tableRouteBase, rowSlug))
}

export async function getPublishedRedirectByPath(db: DbClient, publicPath: string): Promise<DataRowRedirect | null> {
  const slash = publicPath.lastIndexOf('/')
  const base = publicPath.slice(0, slash) || '/'
  const slug = publicPath.slice(slash + 1)
  const { rows } = await db<DataRowRedirectRow>`
    select redirects.id, redirects.from_route_base, redirects.from_slug,
           versions.public_path as target_path
    from data_row_redirects redirects
    join data_rows target_rows on target_rows.id = redirects.target_row_id
    join data_tables on data_tables.id = target_rows.table_id
    join data_row_localizations variants on variants.row_id = target_rows.id and variants.locale_id = redirects.locale_id
    join data_row_versions versions on versions.id = variants.active_version_id
      and versions.row_id = variants.row_id and versions.locale_id = variants.locale_id
    join site_locales locales on locales.id = variants.locale_id
    where redirects.from_route_base = ${base} and redirects.from_slug = ${slug}
      and variants.availability = 'online' and locales.enabled = ${true}
      and target_rows.deleted_at is null and data_tables.deleted_at is null
      and versions.public_path is not null
    limit 1
  `
  const row = rows[0]
  if (!row || row.target_path === publicPath) return null
  return { id: row.id, fromPath: publicPath, targetPath: row.target_path }
}

// ---------------------------------------------------------------------------
// Bundle export / import — raw redirect rows
// ---------------------------------------------------------------------------

/**
 * A redirect serialized for bundle transfer, in raw column form (camelCased).
 * Shape-compatible with `BundleRedirect` in `@core/data/bundleSchema` so the
 * export handler can pass these straight through.
 */
export type ExportableRedirect = BundleRedirect

interface ExportableRedirectRow {
  locale_id: string
  id: string
  table_id: string
  from_route_base: string
  from_slug: string
  target_row_id: string
}

/** Every redirect, raw, for a full-site export. */
export async function listExportableRedirects(db: DbClient): Promise<ExportableRedirect[]> {
  const { rows } = await db<ExportableRedirectRow>`
    select id, table_id, locale_id, from_route_base, from_slug, target_row_id
    from data_row_redirects
    order by from_route_base asc, from_slug asc
  `
  return rows.map((row) => ({
    id: row.id,
    localeId: row.locale_id,
    tableId: row.table_id,
    fromRouteBase: row.from_route_base,
    fromSlug: row.from_slug,
    targetRowId: row.target_row_id,
  }))
}

/** Wipe all redirects — used by the `replace` import strategy before reinsert. */
export async function deleteAllDataRowRedirects(db: DbClient): Promise<void> {
  await db`delete from data_row_redirects`
}

/**
 * Insert a redirect preserving its original id, upserting on the unique
 * (from_route_base, from_slug) source key. Used by the bundle import handler.
 */
export async function importDataRowRedirect(db: DbClient, input: ExportableRedirect): Promise<void> {
  await db`
    insert into data_row_redirects (id, table_id, locale_id, from_route_base, from_slug, target_row_id)
    values (
      ${input.id},
      ${input.tableId},
      ${input.localeId},
      ${input.fromRouteBase},
      ${input.fromSlug},
      ${input.targetRowId}
    )
    on conflict (from_route_base, from_slug) do update
      set table_id = excluded.table_id,
          locale_id = excluded.locale_id,
          target_row_id = excluded.target_row_id
  `
}
