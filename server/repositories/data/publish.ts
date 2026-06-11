/**
 * Publishing flow + public-route lookups for data rows.
 *
 *   publishDataRow                — append a new data_row_versions row, flip
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
 */
import { nanoid } from 'nanoid'
import { placeholder, type DbClient } from '../../db/client'
import { userRefColumns, userRefJoin } from './shared'
import type { DataRow, DataRowVersion, DataRowRedirect, PublishedDataRow } from '@core/data/schemas'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { resolveTemplateChain } from '@core/templates'
import { readFeaturedMediaCell } from '@core/data/cells'
import { getDataRow } from './rows'
import { nextDataRowVersionNumber } from './versions'
import { isoDate } from '@core/utils/isoDate'
import { getLatestPublishedSiteSnapshot } from '../publish'
import {
  renderPublishedDataRowTemplate,
} from '../../publish/publicRenderer'
import { applyPublishedHtmlPipeline } from '../../publish/publishedHtmlPipeline'
import { removeArtefactInPlace, updateArtefactInPlace } from '../../publish/staticArtefact'
import { bumpPublishVersion, getPublishVersion, withPublishLock } from '../../publish/publishState'

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

interface PublishDataRowResult {
  row: DataRow
  version: DataRowVersion
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function publicDataPath(routeBase: string, slug: string): string {
  const normalizedBase = normalizeRouteBase(routeBase)
  return `${normalizedBase === '/' ? '' : normalizedBase}/${slug}`
}

function previousRouteChanged(previous: PreviousPublishedRouteRow, currentSlug: string): boolean {
  return (
    previous.previous_slug.length > 0 &&
    publicDataPath(previous.previous_route_base, previous.previous_slug) !==
      publicDataPath(previous.previous_route_base, currentSlug)
  )
}

// ---------------------------------------------------------------------------
// Internal shape for table route info lookup
// ---------------------------------------------------------------------------

interface RowTableRouteInfo {
  tableRouteBase: string
  tableSlug: string
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export async function publishDataRow(
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
  uploadsDir?: string,
): Promise<PublishDataRowResult> {
  // Serialize against every other publish so the version read→bake→bump window
  // can't interleave and mis-stamp baked hole shells (ISS-038).
  return withPublishLock(() => publishDataRowLocked(db, rowId, publisherUserId, uploadsDir))
}

async function publishDataRowLocked(
  db: DbClient,
  rowId: string,
  publisherUserId: string | null,
  uploadsDir?: string,
): Promise<PublishDataRowResult> {
  // Capture previous route inside the transaction and extract it for
  // use in the post-transaction disk artefact write.
  let capturedPreviousRoute: PreviousPublishedRouteRow | null = null

  const result = await db.transaction(async (tx) => {
    const row = await getDataRow(tx, rowId)
    if (!row) throw new Error('data row not found')

    capturedPreviousRoute = await readPreviousPublishedRoute(tx, rowId)
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

    if (capturedPreviousRoute && previousRouteChanged(capturedPreviousRoute, row.slug)) {
      await tx`
        insert into data_row_redirects (id, table_id, from_route_base, from_slug, target_row_id)
        values (
          ${nanoid()},
          ${row.tableId},
          ${normalizeRouteBase(capturedPreviousRoute.previous_route_base)},
          ${capturedPreviousRoute.previous_slug},
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
    }
  })

  // Layer A: incremental artefact update outside the transaction.
  // Disk artefacts are derived state — errors are logged but do not fail
  // the publish. The next full publish (publishDraftSite) will rebuild.
  if (uploadsDir) {
    // Bake with the NEXT publish version — `bumpPublishVersion()` below is the
    // synchronous statement right after this await resolves, so a hole-shell
    // baked here carries the version that becomes current with no gap.
    const nextPublishVersion = getPublishVersion() + 1
    await writeDataRowArtefact(db, uploadsDir, result.row, capturedPreviousRoute, nextPublishVersion).catch((err) => {
      console.error('[publish:row] static artefact write failed (live renderer remains active):', err)
    })
  }

  // Layer B: invalidate the in-memory render cache so the next visitor request
  // re-renders against the freshly committed row version.
  bumpPublishVersion()

  return result
}

/**
 * After a successful `publishDataRow` transaction, write (or remove) the disk
 * artefact for the row's entry-template page.
 *
 * The artefact is baked whether or not the template is fully static: a static
 * template bakes a complete document; a template with dynamic nodes bakes its
 * static SHELL with `<instatic-hole>` placeholders (the hole runtime hydrates each
 * fragment from `/_instatic/hole/`). Either way HTML + CSS + JS come from disk.
 *
 * Steps:
 *   1. Remove the old artefact if the slug changed (old URL no longer valid).
 *   2. Look up the table route info and site snapshot.
 *   3. Render through the template (stamping `publishVersion`) and write the
 *      artefact into the active slot.
 */
async function writeDataRowArtefact(
  db: DbClient,
  uploadsDir: string,
  publishedRow: DataRow,
  previousRoute: PreviousPublishedRouteRow | null,
  publishVersion: number,
): Promise<void> {
  const tableInfo = await getRowTableRouteInfo(db, publishedRow.id)
  if (!tableInfo) return

  // Remove old artefact when the slug changed (old URL is now stale).
  if (previousRoute && previousRouteChanged(previousRoute, publishedRow.slug)) {
    const oldPath = publicDataPath(previousRoute.previous_route_base, previousRoute.previous_slug)
    await removeArtefactInPlace(uploadsDir, oldPath).catch((err) => {
      console.error('[publish:row] failed to remove stale artefact at', oldPath, err)
    })
  }

  // Resolve the full template chain for this row's table (everywhere layout +
  // entry template). No chain → no entry route to bake.
  const siteSnapshot = await getLatestPublishedSiteSnapshot(db)
  if (!siteSnapshot) return

  const chain = resolveTemplateChain(siteSnapshot.site, { kind: 'entry', tableSlug: tableInfo.tableSlug })
  if (chain.length === 0) return

  // Fetch the full PublishedDataRow (needed for templateContext + media path).
  const publishedDataRow = await getPublishedDataRowByRoute(db, tableInfo.tableRouteBase, publishedRow.slug)
  if (!publishedDataRow) return

  const newPath = publicDataPath(tableInfo.tableRouteBase, publishedRow.slug)
  const syntheticUrl = new URL(`http://localhost${newPath}`)
  const rendered = await renderPublishedDataRowTemplate(siteSnapshot, publishedDataRow, {
    db,
    url: syntheticUrl,
    publishVersion,
  })
  if (!rendered) return

  const html = await applyPublishedHtmlPipeline(rendered, db)
  await updateArtefactInPlace(uploadsDir, newPath, html)
}

/**
 * Fetch the `route_base` and `slug` of the `data_tables` row that owns
 * the given data row. Used by `writeDataRowArtefact` to resolve
 * the public URL path without joining the table into every other query.
 */
async function getRowTableRouteInfo(
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
 * Remove a data row's baked Layer-A artefact from the active slot. Called when
 * a row leaves public visibility (unpublish, revert-to-draft, soft-delete) so
 * the static file stops being served — Layer A reads the disk slot with no
 * publishVersion awareness, so without this a retracted row stays public
 * (ISS-039). The route is resolved WITHOUT the `deleted_at is null` filter so
 * it still works after a soft delete. Best-effort: unresolved route or missing
 * file is a no-op (removeArtefactInPlace never throws on a missing file).
 */
export async function removeDataRowArtefact(
  db: DbClient,
  uploadsDir: string,
  rowId: string,
  slug: string,
): Promise<void> {
  const { rows } = await db<{ route_base: string }>`
    select data_tables.route_base
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    where data_rows.id = ${rowId}
    limit 1
  `
  if (!rows[0]) return
  await removeArtefactInPlace(uploadsDir, publicDataPath(rows[0].route_base, slug))
}

async function readPreviousPublishedRoute(
  db: DbClient,
  rowId: string,
): Promise<PreviousPublishedRouteRow | null> {
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
  return rows[0] ?? null
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
