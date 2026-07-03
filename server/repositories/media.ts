import { type DbClient, placeholder } from '../db/client'
import {
  MEDIA_ASSET_COLUMNS,
  MEDIA_ASSET_INSERT_COLUMNS,
  mapMediaAssetRow,
  parseVariants,
  type MediaAssetRow,
} from './mediaAssetMapping'
import type { MediaAsset, MediaVariant } from './mediaTypes'

// The row ↔ asset mapping unit (column constants, `MediaAssetRow`,
// `mapMediaAssetRow`, and the JSON parsers) lives in `./mediaAssetMapping` so it
// can be shared verbatim with the publisher's render-time prefetch without
// duplication. This module owns the asset domain types (`MediaAsset`,
// `MediaVariant`) and every CRUD query.

export type { MediaAsset, MediaVariant } from './mediaTypes'

interface CreateMediaAssetInput {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  publicPath: string
  uploadedByUserId: string | null
  /** Empty string = local-disk; otherwise the namespaced adapter id. */
  storageAdapterId: string
  /** True when this row's bytes are stored outside the host's uploads dir. */
  externallyHosted: boolean
}

export interface UpdateMediaAssetMetadataInput {
  filename?: string
  altText?: string
  caption?: string
  title?: string
  tags?: string[]
}

interface DeletedMediaAssetRow {
  storage_path: string
}

/**
 * Hydrate the asset → folder-id map for a batch of assets. One round trip,
 * grouped by asset id. Used by every list / get path so the caller sees the
 * full multi-folder membership without an N+1.
 */
async function loadFolderIdsForAssets(
  db: DbClient,
  assetIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (assetIds.length === 0) return map
  for (const id of assetIds) map.set(id, [])

  // Cross-dialect IN-list: SQLite has no native array binding and the shared
  // `DbClient` tagged-template form can't expand a JS array into a SQL IN list.
  // So we build the placeholder list explicitly through `placeholder()` and
  // group in JS — one round-trip for the whole batch, dialect-naive ANSI SQL.
  const placeholders = assetIds.map((_, i) => placeholder(db.dialect, i + 1)).join(', ')
  const { rows } = await db.unsafe<{ asset_id: string; folder_id: string }>(
    `select asset_id, folder_id from media_asset_folders
     where asset_id in (${placeholders})`,
    assetIds,
  )
  for (const row of rows) {
    map.get(row.asset_id)?.push(row.folder_id)
  }
  return map
}

async function hydrateAssets(
  db: DbClient,
  rows: MediaAssetRow[],
): Promise<MediaAsset[]> {
  const folderMap = await loadFolderIdsForAssets(db, rows.map((r) => r.id))
  return rows.map((row) => mapMediaAssetRow(row, folderMap.get(row.id) ?? []))
}

export async function createMediaAsset(
  db: DbClient,
  input: CreateMediaAssetInput,
): Promise<MediaAsset> {
  // SQLite cross-dialect note: boolean values bind as `true`/`false` for
  // Postgres but need 1/0 for SQLite. Both the tagged-template and the
  // `db.unsafe` paths route params through the SQLite adapter's `toBindable`
  // coercion (`server/db/sqlite.ts`), so passing a JS boolean works against
  // both engines.
  //
  // Values are keyed by column name and read back in `MEDIA_ASSET_INSERT_COLUMNS`
  // order, so the tuple and the placeholders share one source of truth and
  // cannot desync.
  const valuesByColumn: Record<(typeof MEDIA_ASSET_INSERT_COLUMNS)[number], unknown> = {
    id: input.id,
    filename: input.filename,
    mime_type: input.mimeType,
    size_bytes: input.sizeBytes,
    storage_path: input.storagePath,
    public_path: input.publicPath,
    uploaded_by_user_id: input.uploadedByUserId,
    storage_adapter_id: input.storageAdapterId,
    externally_hosted: input.externallyHosted,
  }
  const params = MEDIA_ASSET_INSERT_COLUMNS.map((column) => valuesByColumn[column])
  const placeholders = MEDIA_ASSET_INSERT_COLUMNS.map((_, i) => placeholder(db.dialect, i + 1)).join(', ')
  const { rows } = await db.unsafe<MediaAssetRow>(
    `insert into media_assets (${MEDIA_ASSET_INSERT_COLUMNS.join(', ')})
     values (${placeholders})
     returning ${MEDIA_ASSET_COLUMNS}`,
    params,
  )
  return mapMediaAssetRow(rows[0])
}

export async function getMediaAsset(
  db: DbClient,
  id: string,
): Promise<MediaAsset | null> {
  const { rows } = await db.unsafe<MediaAssetRow>(
    `select ${MEDIA_ASSET_COLUMNS}
     from media_assets
     where id = ${placeholder(db.dialect, 1)}`,
    [id],
  )
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * List every media asset (active or in-trash, never both). The repo intentionally
 * returns the full set and lets the handler apply additional filters (folder /
 * type / search / tag / sort / pagination) in JS — cross-dialect dynamic SQL
 * with optional WHERE clauses is fragile and the media library is small enough
 * (low thousands per site) that the round-trip dominates. If a site grows past
 * the comfort zone we'll move filters server-side per-dialect; not premature
 * optimization for M2.
 */
export async function listMediaAssets(
  db: DbClient,
  options: { includeDeleted?: boolean } = {},
): Promise<MediaAsset[]> {
  // Two queries, not one, because cross-dialect optional WHERE clauses in
  // tagged templates require literal SQL text — `includeDeleted` is the
  // only branch.
  const { rows } = options.includeDeleted
    ? await db.unsafe<MediaAssetRow>(
        `select ${MEDIA_ASSET_COLUMNS}
         from media_assets
         where deleted_at is not null
         order by deleted_at desc`,
      )
    : await db.unsafe<MediaAssetRow>(
        `select ${MEDIA_ASSET_COLUMNS}
         from media_assets
         where deleted_at is null
         order by created_at desc`,
      )
  return hydrateAssets(db, rows)
}

export async function renameMediaAsset(
  db: DbClient,
  id: string,
  filename: string,
): Promise<MediaAsset | null> {
  const { rows } = await db.unsafe<MediaAssetRow>(
    `update media_assets set filename = ${placeholder(db.dialect, 1)}
     where id = ${placeholder(db.dialect, 2)}
     returning ${MEDIA_ASSET_COLUMNS}`,
    [filename, id],
  )
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Patch user-editable metadata. The query updates every field unconditionally
 * using COALESCE — undefined inputs map to NULL which preserves the existing
 * column value. This keeps the query shape stable across dialects.
 */
export async function updateMediaAssetMetadata(
  db: DbClient,
  id: string,
  input: UpdateMediaAssetMetadataInput,
): Promise<MediaAsset | null> {
  // Canonical form for the tag column: lowercased, dedup, sorted so equality
  // checks against a "{ tag }" filter behave predictably and the JSON
  // representation is stable across writes.
  const tags = input.tags
    ? Array.from(new Set(input.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))).sort()
    : null

  const filename = input.filename ?? null
  const altText = input.altText ?? null
  const caption = input.caption ?? null
  const title = input.title ?? null

  const p = (n: number) => placeholder(db.dialect, n)
  const { rows } = await db.unsafe<MediaAssetRow>(
    `update media_assets set
       filename = coalesce(${p(1)}, filename),
       alt_text = coalesce(${p(2)}, alt_text),
       caption = coalesce(${p(3)}, caption),
       title = coalesce(${p(4)}, title),
       tags_json = coalesce(${p(5)}, tags_json)
     where id = ${p(6)}
     returning ${MEDIA_ASSET_COLUMNS}`,
    [filename, altText, caption, title, tags, id],
  )
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Stamp the responsive-pipeline output (intrinsic dimensions + BlurHash +
 * variant index) onto a media row. Called by the upload + replace-file
 * handlers immediately after the variants are written to disk. Kept
 * separate from `updateMediaAssetMetadata` because:
 *   1. These columns are NOT user-editable; they're set exactly once per
 *      binary (or once per replace).
 *   2. We always want to overwrite even when the value happens to be
 *      `null` (e.g. a replaced image with no probable dimensions) — the
 *      COALESCE-keep semantics in `updateMediaAssetMetadata` would be
 *      wrong here.
 */
export async function setMediaAssetVariants(
  db: DbClient,
  id: string,
  input: {
    width: number | null
    height: number | null
    blurHash: string | null
    variants: MediaVariant[]
  },
): Promise<MediaAsset | null> {
  const p = (n: number) => placeholder(db.dialect, n)
  const { rows } = await db.unsafe<MediaAssetRow>(
    `update media_assets set
       width = ${p(1)},
       height = ${p(2)},
       blur_hash = ${p(3)},
       variants_json = ${p(4)}
     where id = ${p(5)}
     returning ${MEDIA_ASSET_COLUMNS}`,
    [input.width, input.height, input.blurHash, input.variants, id],
  )
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Soft delete: stamp `deleted_at`. Restore un-stamps; `deleteMediaAsset`
 * finishes the job by removing the row (and caller removes the on-disk file).
 */
export async function softDeleteMediaAsset(
  db: DbClient,
  id: string,
): Promise<MediaAsset | null> {
  const nowIso = new Date().toISOString()
  const { rows } = await db.unsafe<MediaAssetRow>(
    `update media_assets set deleted_at = ${placeholder(db.dialect, 1)}
     where id = ${placeholder(db.dialect, 2)} and deleted_at is null
     returning ${MEDIA_ASSET_COLUMNS}`,
    [nowIso, id],
  )
  if (rows.length === 0) return getMediaAsset(db, id)
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

export async function restoreMediaAsset(
  db: DbClient,
  id: string,
): Promise<MediaAsset | null> {
  const { rows } = await db.unsafe<MediaAssetRow>(
    `update media_assets set deleted_at = null
     where id = ${placeholder(db.dialect, 1)}
     returning ${MEDIA_ASSET_COLUMNS}`,
    [id],
  )
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Hard delete — removes the row. Caller is responsible for removing the
 * on-disk file using the returned `storagePath`.
 */
export async function deleteMediaAsset(
  db: DbClient,
  id: string,
): Promise<{ storagePath: string } | null> {
  const { rows } = await db<DeletedMediaAssetRow>`
    delete from media_assets
    where id = ${id}
    returning storage_path
  `
  const row = rows[0]
  return row ? { storagePath: row.storage_path } : null
}

/**
 * Replace the binary backing this asset while keeping the same id so every
 * existing reference stays valid.
 *
 * `public_path` is no longer guaranteed stable — when the storage adapter
 * elected for the role differs from the one that wrote the previous
 * binary, the new bytes live on a different backend with a different
 * URL. Renderers reference media by asset id (or path) via the
 * `prefetchMediaAssets` lookup, which re-resolves on each publish, so a
 * URL change is transparent to consumers.
 */
export async function replaceMediaAssetBinary(
  db: DbClient,
  id: string,
  input: {
    filename: string
    mimeType: string
    sizeBytes: number
    storagePath: string
    publicPath: string
    storageAdapterId: string
    externallyHosted: boolean
  },
): Promise<MediaAsset | null> {
  const nowIso = new Date().toISOString()
  const p = (n: number) => placeholder(db.dialect, n)
  const { rows } = await db.unsafe<MediaAssetRow>(
    `update media_assets set
       filename = ${p(1)},
       mime_type = ${p(2)},
       size_bytes = ${p(3)},
       storage_path = ${p(4)},
       public_path = ${p(5)},
       storage_adapter_id = ${p(6)},
       externally_hosted = ${p(7)},
       replaced_at = ${p(8)}
     where id = ${p(9)}
     returning ${MEDIA_ASSET_COLUMNS}`,
    [
      input.filename,
      input.mimeType,
      input.sizeBytes,
      input.storagePath,
      input.publicPath,
      input.storageAdapterId,
      input.externallyHosted,
      nowIso,
      id,
    ],
  )
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Storage path of an existing asset without deleting it — used by the
 * replace-file handler to remove the previous binary after writing the new
 * one.
 */
export async function getMediaAssetStoragePath(
  db: DbClient,
  id: string,
): Promise<string | null> {
  const { rows } = await db<{ storage_path: string }>`
    select storage_path from media_assets where id = ${id}
  `
  return rows[0]?.storage_path ?? null
}

/**
 * Pull just the responsive variants for an asset so the replace + purge
 * paths can sweep them off disk alongside the original. Returns an empty
 * array for assets that never had variants (non-image uploads, very small
 * images that didn't need a ladder).
 */
export async function getMediaAssetVariants(
  db: DbClient,
  id: string,
): Promise<MediaVariant[]> {
  const { rows } = await db<{ variants_json: unknown }>`
    select variants_json from media_assets where id = ${id}
  `
  if (rows.length === 0) return []
  return parseVariants(rows[0].variants_json)
}

/**
 * Add and/or remove an asset's folder memberships in one transactional step.
 * Idempotent: re-adding an existing membership is a no-op (relies on the
 * primary key + an INSERT … ON CONFLICT DO NOTHING).
 */
export async function assignAssetToFolders(
  db: DbClient,
  assetId: string,
  input: { add?: string[]; remove?: string[] },
): Promise<MediaAsset | null> {
  return db.transaction(async (tx) => {
    for (const folderId of input.remove ?? []) {
      await tx`
        delete from media_asset_folders
        where asset_id = ${assetId} and folder_id = ${folderId}
      `
    }
    for (const folderId of input.add ?? []) {
      // Cross-dialect upsert — PG 9.5+ and SQLite 3.24+ both accept
      // `ON CONFLICT DO NOTHING` on a primary key conflict.
      await tx`
        insert into media_asset_folders (asset_id, folder_id)
        values (${assetId}, ${folderId})
        on conflict do nothing
      `
    }
    return getMediaAsset(tx, assetId)
  })
}

// ---------------------------------------------------------------------------
// Bundle export / import helpers
// ---------------------------------------------------------------------------

/** Extended asset row that also returns the storage_path column. */
interface MediaAssetExportRow extends MediaAssetRow {
  storage_path: string
}

/**
 * List all non-deleted media assets including their storage paths for bundle
 * export. Storage path is kept separate from the normal `listMediaAssets` query
 * because the public read paths never need to expose it.
 */
/** Count of non-deleted media assets available to export (no row hydration). */
export async function countMediaAssetsForExport(db: DbClient): Promise<number> {
  const { rows } = await db<{ n: number | string }>`
    select count(*) as n from media_assets where deleted_at is null
  `
  return Number(rows[0]?.n ?? 0)
}

export async function listMediaAssetsForExport(db: DbClient): Promise<Array<MediaAsset & { storagePath: string }>> {
  const { rows } = await db.unsafe<MediaAssetExportRow>(
    `select ${MEDIA_ASSET_COLUMNS}, storage_path
     from media_assets
     where deleted_at is null
     order by created_at asc`,
  )
  const folderMap = await loadFolderIdsForAssets(db, rows.map((r) => r.id))
  return rows.map((row) => ({
    ...mapMediaAssetRow(row, folderMap.get(row.id) ?? []),
    storagePath: row.storage_path,
  }))
}

interface ImportMediaAssetInput {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  publicPath: string
  altText: string
  caption: string
  title: string
  tags: string[]
  width: number | null
  height: number | null
  durationMs: number | null
  dominantColor: string | null
  blurHash: string | null
  posterPath: string | null
  /** Optional; defaults to local-disk when omitted. */
  storageAdapterId?: string
  /** Optional; defaults to false when omitted. */
  externallyHosted?: boolean
}

/**
 * Insert a media asset record preserving its original id and metadata.
 * Used exclusively by the bundle import handler.
 *
 * Variants are intentionally omitted — imported assets publish from the
 * original until a later upload/replace path regenerates variants.
 * Folder memberships are not imported (no folder rows to link to yet in
 * the target instance).
 *
 * If an asset with the same id already exists it is replaced.
 */
export async function importMediaAsset(
  db: DbClient,
  input: ImportMediaAssetInput,
): Promise<void> {
  const tags = Array.from(new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))).sort()
  const storageAdapterId = input.storageAdapterId ?? ''
  const externallyHosted = input.externallyHosted ?? false
  await db`
    insert into media_assets (
      id, filename, mime_type, size_bytes, storage_path, public_path,
      alt_text, caption, title, tags_json, width, height, duration_ms,
      dominant_color, blur_hash, poster_path,
      storage_adapter_id, externally_hosted
    )
    values (
      ${input.id}, ${input.filename}, ${input.mimeType}, ${input.sizeBytes},
      ${input.storagePath}, ${input.publicPath},
      ${input.altText}, ${input.caption}, ${input.title}, ${tags},
      ${input.width}, ${input.height}, ${input.durationMs},
      ${input.dominantColor}, ${input.blurHash}, ${input.posterPath},
      ${storageAdapterId}, ${externallyHosted}
    )
    on conflict (id) do update
      set filename      = excluded.filename,
          mime_type     = excluded.mime_type,
          size_bytes    = excluded.size_bytes,
          storage_path  = excluded.storage_path,
          public_path   = excluded.public_path,
          alt_text      = excluded.alt_text,
          caption       = excluded.caption,
          title         = excluded.title,
          tags_json     = excluded.tags_json,
          width         = excluded.width,
          height        = excluded.height,
          duration_ms   = excluded.duration_ms,
          dominant_color = excluded.dominant_color,
          blur_hash     = excluded.blur_hash,
          poster_path   = excluded.poster_path,
          storage_adapter_id = excluded.storage_adapter_id,
          externally_hosted = excluded.externally_hosted
  `
}
