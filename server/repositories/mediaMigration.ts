/**
 * Repository helpers for the media-storage migration tool.
 *
 * Two surfaces:
 *
 *   • `countMigrationBacklog(...)` — given a (role, targetAdapterId),
 *     return how many rows / variants need to move. Powers the
 *     "Migrate N assets" badge in the storage admin panel.
 *
 *   • Iteration / update helpers used by the per-asset migration loop:
 *       - `listPendingOriginals` — paginated rows whose
 *         storage_adapter_id != target.
 *       - `listAssetsWithPendingVariants` — paginated rows that have at
 *         least one variant on a non-target adapter.
 *       - `updateAssetStorageLocation` — write the new storage_path /
 *         public_path / storage_adapter_id / externally_hosted onto a
 *         row after the destination upload succeeds.
 *       - `updateVariantStorageLocation` — same shape but for one
 *         variant entry inside a row's `variants_json`.
 *
 * All counts + lists exclude soft-deleted rows. The migration tool
 * intentionally skips Trash: anything in Trash is on its way out
 * (`hard-delete` purges the bytes anyway), so spending bandwidth moving
 * it across adapters would be wasted work.
 */

import type { DbClient } from '../db/client'
import type { MediaVariant } from './media'

interface PendingOriginalRow {
  id: string
  filename: string
  mime_type: string
  size_bytes: number | string
  storage_path: string
  public_path: string
  storage_adapter_id: string
}

interface PendingVariantContainerRow {
  id: string
  storage_path: string
  variants_json: unknown
}

export interface PendingOriginal {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  publicPath: string
  storageAdapterId: string
}

export interface PendingVariantContainer {
  /** Parent asset id. */
  id: string
  /** Parent's storagePath — used when uploading variants (as `variantOf`). */
  parentStoragePath: string
  /** Raw variants list (some entries may already be on the target). */
  variants: MediaVariant[]
}

function parseVariantsFromJson(value: unknown): MediaVariant[] {
  // Mirrors the parser in `repositories/media.ts:parseVariants` but
  // duplicated here to keep this module free of cross-imports past
  // the type. Old rows without storagePath/storageAdapterId fall back
  // to local-disk semantics — same canonical derivation.
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => { try { return JSON.parse(value) } catch { return [] } })()
      : []
  if (!Array.isArray(raw)) return []
  const out: MediaVariant[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.width !== 'number' || typeof e.height !== 'number') continue
    if (typeof e.path !== 'string' || typeof e.sizeBytes !== 'number') continue
    if (e.format !== 'webp' && e.format !== 'jpeg' && e.format !== 'png' && e.format !== 'avif') continue
    const storagePath = typeof e.storagePath === 'string' && e.storagePath
      ? e.storagePath
      : e.path.startsWith('/uploads/')
        ? e.path.slice('/uploads/'.length)
        : e.path
    const storageAdapterId = typeof e.storageAdapterId === 'string' ? e.storageAdapterId : ''
    out.push({
      width: e.width,
      height: e.height,
      format: e.format,
      path: e.path,
      sizeBytes: e.sizeBytes,
      storagePath,
      storageAdapterId,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Backlog counts
// ---------------------------------------------------------------------------

interface MigrationBacklog {
  /** Total `media_assets` rows whose storage_adapter_id != target. */
  originals: number
  /**
   * Total VARIANT ENTRIES across all rows whose storageAdapterId != target.
   * Computed JS-side from `variants_json` because the value is a JSON blob
   * (no per-variant DB row exists). For sites with thousands of assets the
   * JS pass is still fast — variants per asset are bounded by the
   * `TARGET_WIDTHS` ladder plus the intrinsic rung (≤ 7).
   */
  variants: number
}

/**
 * Count how many rows / variants are still on a non-target adapter for
 * each role. Used by the storage admin panel to surface the
 * "Migrate N assets →" affordance.
 *
 * Caller passes a snapshot of the elected adapter ids per role
 * (target). Roles other than 'original' / 'variant' are reported as 0
 * in v1 — see the file-level comment in `mediaStorageMigration.ts` for
 * why avatar/font/plugin-pack are out of scope for now.
 */
export async function countMigrationBacklog(
  db: DbClient,
  targets: { original: string; variant: string },
): Promise<MigrationBacklog> {
  // Originals — single COUNT query, exact total.
  const { rows: originalRows } = await db<{ n: number | string }>`
    select count(*) as n
    from media_assets
    where storage_adapter_id <> ${targets.original}
      and deleted_at is null
  `
  const originals = Number(originalRows[0]?.n ?? 0)

  // Variants — pull every variants_json that has at least one non-target
  // entry. `variants_json` is a JSON column with no per-engine query
  // operators we can portably rely on (jsonb in PG, text in SQLite), so
  // we filter JS-side after a coarse `is not null` predicate.
  const { rows: variantRows } = await db<{ variants_json: unknown }>`
    select variants_json
    from media_assets
    where deleted_at is null
      and variants_json is not null
  `
  let variants = 0
  for (const row of variantRows) {
    const list = parseVariantsFromJson(row.variants_json)
    for (const v of list) {
      if (v.storageAdapterId !== targets.variant) variants += 1
    }
  }
  return { originals, variants }
}

// ---------------------------------------------------------------------------
// Iteration — paginated lists for the migration loop
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 50

export async function listPendingOriginals(
  db: DbClient,
  targetAdapterId: string,
  cursor: string | null,
): Promise<{ items: PendingOriginal[]; nextCursor: string | null }> {
  // Cursor pagination keyed on id (lexicographic). Stable across DB
  // engines and immune to "new row inserted during migration" pagination
  // skips that OFFSET-based queries suffer from.
  const { rows } = cursor
    ? await db<PendingOriginalRow>`
        select id, filename, mime_type, size_bytes, storage_path, public_path, storage_adapter_id
        from media_assets
        where storage_adapter_id <> ${targetAdapterId}
          and deleted_at is null
          and id > ${cursor}
        order by id asc
        limit ${PAGE_LIMIT}
      `
    : await db<PendingOriginalRow>`
        select id, filename, mime_type, size_bytes, storage_path, public_path, storage_adapter_id
        from media_assets
        where storage_adapter_id <> ${targetAdapterId}
          and deleted_at is null
        order by id asc
        limit ${PAGE_LIMIT}
      `

  const items: PendingOriginal[] = rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    storagePath: row.storage_path,
    publicPath: row.public_path,
    storageAdapterId: row.storage_adapter_id,
  }))
  const nextCursor = items.length === PAGE_LIMIT ? items[items.length - 1].id : null
  return { items, nextCursor }
}

export async function listAssetsWithPendingVariants(
  db: DbClient,
  targetAdapterId: string,
  cursor: string | null,
): Promise<{ items: PendingVariantContainer[]; nextCursor: string | null }> {
  const { rows } = cursor
    ? await db<PendingVariantContainerRow>`
        select id, storage_path, variants_json
        from media_assets
        where deleted_at is null
          and variants_json is not null
          and id > ${cursor}
        order by id asc
        limit ${PAGE_LIMIT}
      `
    : await db<PendingVariantContainerRow>`
        select id, storage_path, variants_json
        from media_assets
        where deleted_at is null
          and variants_json is not null
        order by id asc
        limit ${PAGE_LIMIT}
      `

  const items: PendingVariantContainer[] = []
  for (const row of rows) {
    const variants = parseVariantsFromJson(row.variants_json)
    const hasPending = variants.some((v) => v.storageAdapterId !== targetAdapterId)
    if (!hasPending) continue
    items.push({
      id: row.id,
      parentStoragePath: row.storage_path,
      variants,
    })
  }
  // Cursor advances on the underlying row scan, not on items kept.
  // Without that an entire batch of "all-already-migrated" rows would
  // loop forever — the loop must see the cursor move regardless.
  const nextCursor = rows.length === PAGE_LIMIT ? rows[rows.length - 1].id : null
  return { items, nextCursor }
}

// ---------------------------------------------------------------------------
// Per-asset mutation
// ---------------------------------------------------------------------------

/**
 * Update the storage-location columns on `media_assets` after a successful
 * destination upload. Mirrors `replaceMediaAssetBinary` but only touches
 * the storage fields — filename / mime_type / size_bytes stay untouched
 * because migration preserves the actual content.
 */
export async function updateAssetStorageLocation(
  db: DbClient,
  id: string,
  input: {
    storagePath: string
    publicPath: string
    storageAdapterId: string
    externallyHosted: boolean
  },
): Promise<void> {
  await db`
    update media_assets set
      storage_path = ${input.storagePath},
      public_path = ${input.publicPath},
      storage_adapter_id = ${input.storageAdapterId},
      externally_hosted = ${input.externallyHosted}
    where id = ${id}
  `
}

/**
 * Replace one variant entry inside `variants_json`. Reads the current
 * blob, mutates the matching entry (matched on the OLD `path` value so
 * we don't accidentally rewrite a variant that's already been migrated
 * in a concurrent run), writes it back.
 *
 * The variant entry is identified by `oldPath` because that's what we
 * captured pre-migration. If the row has been replaced or re-migrated
 * in the gap, the match fails and we leave the blob alone — the next
 * migration run picks the new shape up.
 */
export async function updateVariantStorageLocation(
  db: DbClient,
  assetId: string,
  oldPath: string,
  next: {
    path: string
    storagePath: string
    storageAdapterId: string
    sizeBytes: number
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { rows } = await tx<{ variants_json: unknown }>`
      select variants_json from media_assets where id = ${assetId}
    `
    if (rows.length === 0) return false
    const variants = parseVariantsFromJson(rows[0].variants_json)
    let updated = false
    const rewritten = variants.map((v) => {
      if (v.path !== oldPath) return v
      updated = true
      return {
        ...v,
        path: next.path,
        storagePath: next.storagePath,
        storageAdapterId: next.storageAdapterId,
        sizeBytes: next.sizeBytes,
      }
    })
    if (!updated) return false
    await tx`
      update media_assets
      set variants_json = ${rewritten}
      where id = ${assetId}
    `
    return true
  })
}
