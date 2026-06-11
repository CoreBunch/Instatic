/**
 * Shared row ↔ asset mapping for `media_assets`.
 *
 * The single source of truth for how a `media_assets` DB row hydrates into a
 * `MediaAsset`, and for the SQL projection that selects one. Both layers that
 * read media rows import from here:
 *   - `server/repositories/media.ts` (the admin/CRUD repository), and
 *   - `server/publish/mediaPrefetch.ts` (the render-time prefetch),
 * so the admin and the published page can never see a different asset shape.
 * Before this module existed the projection + mapper were hand-copied between
 * the two and had already drifted (the publisher copy dropped
 * `storageAdapterId` / `externallyHosted` and never derived a variant's
 * `storagePath` / `storageAdapterId`).
 *
 * Dialect rules apply: `MEDIA_ASSET_COLUMNS` is ANSI-only and spliced into
 * `db.unsafe` SELECT / RETURNING clauses; JSON columns end in `_json` and are
 * auto-(de)serialized by the SQLite adapter / Postgres jsonb.
 */

import { isoDate, isoDateOrNull } from '@core/utils/isoDate'
import type { MediaAsset, MediaVariant } from './media'

/**
 * Single source of truth for the hydrated media-asset projection. Spliced into
 * every SELECT / RETURNING via `db.unsafe` so a schema change is a one-line edit
 * here instead of an 11-site lockstep edit. `storage_path` is deliberately
 * absent — it's a server-internal handle the public read paths never expose
 * (export/replace helpers append it explicitly when they need it).
 */
export const MEDIA_ASSET_COLUMNS = `id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
       alt_text, caption, title, tags_json, width, height, duration_ms,
       dominant_color, deleted_at, replaced_at,
       blur_hash, variants_json, poster_path,
       storage_adapter_id, externally_hosted`

/**
 * Columns written by `createMediaAsset`'s INSERT (every other column takes its
 * default / NULL at creation and is stamped later). Both the column list and
 * the positional placeholders are derived from this one array, so a column add
 * can't desync the tuple — gated by the arity test in
 * `src/__tests__/server/mediaAssetMapping.test.ts`.
 */
export const MEDIA_ASSET_INSERT_COLUMNS = [
  'id',
  'filename',
  'mime_type',
  'size_bytes',
  'storage_path',
  'public_path',
  'uploaded_by_user_id',
  'storage_adapter_id',
  'externally_hosted',
] as const

export interface MediaAssetRow {
  id: string
  filename: string
  mime_type: string
  size_bytes: number | string
  public_path: string
  uploaded_by_user_id: string | null
  created_at: Date | string
  alt_text: string | null
  caption: string | null
  title: string | null
  tags_json: unknown
  width: number | null
  height: number | null
  duration_ms: number | string | null
  dominant_color: string | null
  deleted_at: Date | string | null
  replaced_at: Date | string | null
  blur_hash: string | null
  variants_json: unknown
  poster_path: string | null
  storage_adapter_id: string
  /** PG: boolean; SQLite: integer 0/1. Read via Boolean(row.externally_hosted). */
  externally_hosted: boolean | number
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === 'string')
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

export function parseVariants(value: unknown): MediaVariant[] {
  // Variants are written by the upload pipeline as a fully-validated array
  // already; the runtime check here is defense against a hand-edited row.
  // Anything that isn't a well-shaped variant gets dropped silently — the
  // asset still serves its original file, just without the responsive ladder.
  //
  // `storagePath` / `storageAdapterId` were added when the media subsystem
  // grew pluggable storage adapters. Older rows without them are derived:
  // `storagePath` from `path` (stripping `/uploads/`), `storageAdapterId`
  // to `''` (local-disk). This is the canonical derivation — not a band-aid
  // — because old rows were always written by the local-disk adapter and
  // their storagePath is structurally `path.slice('/uploads/'.length)`.
  const raw: unknown = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => { try { return JSON.parse(value) } catch { return [] } })()
      : []
  if (!Array.isArray(raw)) return []
  const result: MediaVariant[] = []
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
    result.push({
      width: e.width,
      height: e.height,
      format: e.format,
      path: e.path,
      sizeBytes: e.sizeBytes,
      storagePath,
      storageAdapterId,
    })
  }
  return result
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Canonical row → `MediaAsset` mapper. The single place that knows how a
 * `media_assets` row hydrates into the asset shape, shared by the repository and
 * the publisher's `prefetchMediaAssets` so the admin and the published page can
 * never see a different asset shape. `folderIds` defaults to empty for callers
 * (e.g. the render-time prefetch) that legitimately skip the folder join.
 */
export function mapMediaAssetRow(row: MediaAssetRow, folderIds: string[] = []): MediaAsset {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    publicPath: row.public_path,
    uploadedByUserId: row.uploaded_by_user_id ?? null,
    createdAt: isoDate(row.created_at),
    altText: row.alt_text ?? '',
    caption: row.caption ?? '',
    title: row.title ?? '',
    tags: parseTags(row.tags_json),
    width: numberOrNull(row.width),
    height: numberOrNull(row.height),
    durationMs: numberOrNull(row.duration_ms),
    dominantColor: row.dominant_color ?? null,
    deletedAt: isoDateOrNull(row.deleted_at),
    replacedAt: isoDateOrNull(row.replaced_at),
    folderIds,
    blurHash: row.blur_hash ?? null,
    variants: parseVariants(row.variants_json),
    posterPath: row.poster_path ?? null,
    storageAdapterId: row.storage_adapter_id ?? '',
    externallyHosted: Boolean(row.externally_hosted),
  }
}
