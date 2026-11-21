/**
 * Media widget reader — total asset count + bytes plus the latest 16
 * image thumbs with their variant ladder so the dashboard can build
 * srcset-aware thumbnails for the mosaic.
 */
import type { DbClient } from '../../../db/client'
import { coerceBytes, coerceCount } from '../../../repositories/dashboard'
import type { MediaStats, MediaStatsThumb } from './types'

const THUMB_LIMIT = 16

export async function readMediaStats(db: DbClient): Promise<MediaStats> {
  // Two queries — totals + the latest thumbs — fire in parallel.
  const [totalsResult, latestThumbs] = await Promise.all([
    db<{ count: number | string; bytes: number | string | null }>`
      select count(*) as count, coalesce(sum(size_bytes), 0) as bytes
      from media_assets
      where deleted_at is null
    `,
    readLatestImageThumbs(db, THUMB_LIMIT),
  ])
  const totals = totalsResult.rows[0]
  return {
    count: coerceCount(totals?.count),
    totalBytes: coerceBytes(totals?.bytes),
    latestThumbs,
  }
}

/**
 * Most-recent image-type media assets. The dashboard widget renders
 * them as a thumbnail mosaic via the shared `<Image>` primitive,
 * which builds a srcset from the variant ladder.
 */
async function readLatestImageThumbs(db: DbClient, limit: number): Promise<MediaStatsThumb[]> {
  const { rows } = await db<{
    id: string
    public_path: string
    alt_text: string | null
    mime_type: string
    width: number | null
    height: number | null
    variants_json: unknown
  }>`
    select id, public_path, alt_text, mime_type, width, height, variants_json
    from media_assets
    where deleted_at is null
      and mime_type like 'image/%'
    order by created_at desc
    limit ${limit}
  `
  return rows.map((r) => ({
    id: r.id,
    publicPath: r.public_path,
    altText: r.alt_text ?? '',
    mimeType: r.mime_type,
    width: r.width,
    height: r.height,
    variants: extractVariants(r.variants_json),
  }))
}

type Variant = { width: number; height: number; format: string; path: string }

function extractVariants(value: unknown): Variant[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is Variant => {
      if (!v || typeof v !== 'object') return false
      const x = v as Record<string, unknown>
      return (
        typeof x.width === 'number' &&
        typeof x.height === 'number' &&
        typeof x.format === 'string' &&
        typeof x.path === 'string'
      )
    })
    .map((v) => ({ width: v.width, height: v.height, format: v.format, path: v.path }))
}
