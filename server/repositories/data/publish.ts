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
import { nanoid } from 'nanoid'
import { placeholder, type DbClient } from '../../db/client'
import { userRefColumns, userRefJoin } from './shared'
import type { DataRow, DataRowVersion, DataRowRedirect, PublishedDataRow } from '@core/data/schemas'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { readFeaturedMediaCell } from '@core/data/cells'
import { getDataRow } from './rows'
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

interface PreviousPublishedRouteRow {
  previous_slug: string
  previous_route_base: string
}

interface DataRowRedirectRow {
  id: string
  from_route_base: string
  from_slug: string
  target_route_base: string
  target_slug: string
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

export interface RowTableRouteInfo {
  tableRouteBase: string
  tableSlug: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Public URL path for a row: `<normalized route base>/<slug>`. */
export function publicDataPath(routeBase: string, slug: string): string {
  const normalizedBase = normalizeRouteBase(routeBase)
  return `${normalizedBase === '/' ? '' : normalizedBase}/${slug}`
}

/** True when the previously-published route differs from the current slug's. */
export function previousRouteChanged(previous: PreviousPublishedRoute, currentSlug: string): boolean {
  return (
    previous.slug.length > 0 &&
    publicDataPath(previous.routeBase, previous.slug) !==
      publicDataPath(previous.routeBase, currentSlug)
  )
}

// ---------------------------------------------------------------------------
// Publish persistence
// ---------------------------------------------------------------------------

/**
 * Transactional write of one row publish. DB writes only — the publish lock,
 * artefact bake, and cache bump are owned by `server/publish/publishRow.ts`.
 */
export async function persistDataRowPublish(
  db: DbClient,
  rowId: string,
  /**
   * The user attributed as the publisher. `null` is allowed for system
   * actors that have no user context — e.g. the scheduled-publish tick
   * (`server/publish/publishScheduler.ts`) which fires once
   * `scheduled_publish_at` is in the past. The `published_by_user_id`
   * column on `data_rows` is nullable (`on delete set null`), so a
   * null publisher round-trips cleanly through the schema.
   */
  publisherUserId: string | null,
): Promise<PersistDataRowPublishResult> {
  return db.transaction(async (tx) => {
    const row = await getDataRow(tx, rowId)
    if (!row) throw new Error('data row not found')

    const previousRoute = await readPreviousPublishedRoute(tx, rowId)
    const versionNumber = await nextDataRowVersionNumber(tx, rowId)
    const versionId = nanoid()

    await tx`
      insert into data_row_versions
        (id, row_id, version_number, cells_json, slug, published_by_user_id)
      values (
        ${versionId},
        ${row.id},
        ${versionNumber},
        ${row.cells},
        ${row.slug},
        ${publisherUserId}
      )
    `

    const { rows: updateRows } = await tx<{ id: string }>`
      update data_rows
      set status = 'published',
          active_version_id = ${versionId},
          published_by_user_id = ${publisherUserId},
          published_at = current_timestamp,
          updated_by_user_id = ${publisherUserId},
          updated_at = current_timestamp
      where id = ${row.id}
        and deleted_at is null
      returning id
    `
    if (!updateRows[0]) throw new Error('data row publish update failed')

    if (previousRoute && previousRouteChanged(previousRoute, row.slug)) {
      await tx`
        insert into data_row_redirects (id, table_id, from_route_base, from_slug, target_row_id)
        values (
          ${nanoid()},
          ${row.tableId},
          ${normalizeRouteBase(previousRoute.routeBase)},
          ${previousRoute.slug},
          ${row.id}
        )
        on conflict (from_route_base, from_slug) do update
          set table_id = excluded.table_id,
              target_row_id = excluded.target_row_id
      `
    }

    const publishedRow = await getDataRow(tx, row.id)
    if (!publishedRow) throw new Error('data row could not be re-read after publish')

    const publishedAt = publishedRow.publishedAt ?? new Date().toISOString()
    return {
      row: publishedRow,
      version: {
        id: versionId,
        rowId: publishedRow.id,
        versionNumber,
        cells: publishedRow.cells,
        slug: publishedRow.slug,
        publishedByUserId: publisherUserId,
        publishedAt,
        createdAt: publishedAt,
      },
      previousRoute,
    }
  })
}

async function readPreviousPublishedRoute(
  db: DbClient,
  rowId: string,
): Promise<PreviousPublishedRoute | null> {
  const { rows } = await db<PreviousPublishedRouteRow>`
    select data_row_versions.slug as previous_slug,
           data_tables.route_base as previous_route_base
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    join data_row_versions on data_row_versions.id = data_rows.active_version_id
    where data_rows.id = ${rowId}
      and data_rows.deleted_at is null
      and data_tables.deleted_at is null
    limit 1
  `
  return rows[0]
    ? { slug: rows[0].previous_slug, routeBase: rows[0].previous_route_base }
    : null
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
export async function getRowTableRouteInfo(
  db: DbClient,
  rowId: string,
): Promise<RowTableRouteInfo | null> {
  const { rows } = await db<{ route_base: string; table_slug: string }>`
    select data_tables.route_base,
           data_tables.slug as table_slug
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    where data_rows.id = ${rowId}
      and data_rows.deleted_at is null
      and data_tables.deleted_at is null
    limit 1
  `
  if (!rows[0]) return null
  return {
    tableRouteBase: normalizeRouteBase(rows[0].route_base),
    tableSlug: rows[0].table_slug,
  }
}

/**
 * The owning table's raw `route_base` for a row, resolved WITHOUT the
 * `deleted_at is null` filters — artefact removal must still resolve the
 * route after a soft delete (ISS-039).
 */
export async function getRowTableRouteBase(
  db: DbClient,
  rowId: string,
): Promise<string | null> {
  const { rows } = await db<{ route_base: string }>`
    select data_tables.route_base
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    where data_rows.id = ${rowId}
    limit 1
  `
  return rows[0]?.route_base ?? null
}

// ---------------------------------------------------------------------------
// Public-route lookups
// ---------------------------------------------------------------------------

export interface PublishedRowRoute {
  rowId: string
  /** Slug of the row's ACTIVE published version (what the public URL uses). */
  rowSlug: string
  tableSlug: string
  tableRouteBase: string
}

/**
 * Every published, non-deleted data row (excluding the `pages` table) with
 * its active version's slug and its table's route info. The full publish uses
 * this to bake a Layer A artefact for each row route into the fresh slot —
 * without it, the slot swap would strand every row artefact written by
 * incremental publishes.
 */
export async function listPublishedRowRoutes(db: DbClient): Promise<PublishedRowRoute[]> {
  const { rows } = await db<{
    row_id: string
    row_slug: string
    table_slug: string
    table_route_base: string
  }>`
    select data_rows.id as row_id,
           data_row_versions.slug as row_slug,
           data_tables.slug as table_slug,
           data_tables.route_base as table_route_base
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    join data_row_versions on data_row_versions.id = data_rows.active_version_id
    where data_rows.table_id <> 'pages'
      and data_rows.status = 'published'
      and data_rows.deleted_at is null
      and data_tables.deleted_at is null
    order by data_rows.created_at asc
  `
  return rows.map((row) => ({
    rowId: row.row_id,
    rowSlug: row.row_slug,
    tableSlug: row.table_slug,
    tableRouteBase: normalizeRouteBase(row.table_route_base),
  }))
}

/**
 * Resolve a public URL (tableRouteBase + rowSlug) to the active published
 * version of a data row.
 *
 * `featuredMediaPath` is resolved in app code: first we read
 * `cells.featuredMedia` (via `readFeaturedMediaCell`) from the version's
 * `cells_json`, then — only when a media id is present — we do a second
 * query against `media_assets` for the `public_path`. This keeps the primary
 * query dialect-naive (no JSON-extract functions, no PG-specific operators).
 */
export async function getPublishedDataRowByRoute(
  db: DbClient,
  tableRouteBase: string,
  rowSlug: string,
): Promise<PublishedDataRow | null> {
  const normalizedBase = normalizeRouteBase(tableRouteBase)

  // The author/publisher user-ref joins reuse the shared `userRefColumns` /
  // `userRefJoin` fragments (the single source, also spliced by the hydrated
  // data-row SELECT in `rows/mapper.ts`). The publisher join targets
  // `data_row_versions.published_by_user_id` — the per-version publisher — not
  // `data_rows.published_by_user_id`. SQL stays dialect-naive (ANSI joins,
  // positional `placeholder()` binds).
  const p = (n: number) => placeholder(db.dialect, n)
  const { rows } = await db.unsafe<PublishedDataRowQueryRow>(
    `select data_row_versions.id,
           data_row_versions.row_id,
           data_rows.table_id,
           data_tables.slug as table_slug,
           data_tables.kind as table_kind,
           data_tables.route_base as table_route_base,
           data_row_versions.version_number,
           data_row_versions.cells_json,
           data_row_versions.slug,
           data_rows.author_user_id,
           ${userRefColumns('author')},
           data_row_versions.published_by_user_id,
           ${userRefColumns('published_by')},
           data_row_versions.published_at,
           data_row_versions.created_at
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    join data_row_versions on data_row_versions.id = data_rows.active_version_id
    ${userRefJoin('author', 'data_rows.author_user_id')}
    ${userRefJoin('published_by', 'data_row_versions.published_by_user_id')}
    where data_tables.route_base = ${p(1)}
      and data_row_versions.slug = ${p(2)}
      and data_rows.status = 'published'
      and data_rows.deleted_at is null
      and data_tables.deleted_at is null
    limit 1`,
    [normalizedBase, rowSlug],
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
  const normalizedBase = normalizeRouteBase(tableRouteBase)

  const { rows } = await db<DataRowRedirectRow>`
    select data_row_redirects.id,
           data_row_redirects.from_route_base,
           data_row_redirects.from_slug,
           data_tables.route_base as target_route_base,
           data_row_versions.slug as target_slug
    from data_row_redirects
    join data_rows target_rows on target_rows.id = data_row_redirects.target_row_id
    join data_tables on data_tables.id = target_rows.table_id
    join data_row_versions on data_row_versions.id = target_rows.active_version_id
    where data_row_redirects.from_route_base = ${normalizedBase}
      and data_row_redirects.from_slug = ${rowSlug}
      and target_rows.status = 'published'
      and target_rows.deleted_at is null
      and data_tables.deleted_at is null
    limit 1
  `

  if (!rows[0]) return null

  const queryRow = rows[0]
  const fromPath = publicDataPath(queryRow.from_route_base, queryRow.from_slug)
  const targetPath = publicDataPath(queryRow.target_route_base, queryRow.target_slug)
  if (fromPath === targetPath) return null

  return { id: queryRow.id, fromPath, targetPath }
}
