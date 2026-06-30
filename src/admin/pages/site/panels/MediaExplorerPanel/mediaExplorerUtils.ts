// Pure, side-effect-free helpers for the Media Explorer: view-mode
// persistence, filename/extension parsing, MIME/extension bucketing, and
// search/filter over the loaded asset list. No JSX, no React, no store access.

import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { formatBytes } from '@admin/pages/media/utils/formatBytes'
import type { MediaBucket, MediaFilter } from './mediaExplorerModel'

const VIEW_MODE_STORAGE_KEY = 'instatic-media-explorer-view-mode'

export function readStoredViewMode(): 'list' | 'grid' {
  try {
    const raw = globalThis.localStorage?.getItem(VIEW_MODE_STORAGE_KEY)
    return raw === 'grid' || raw === 'list' ? raw : 'grid'
  } catch {
    return 'grid'
  }
}

export function writeStoredViewMode(mode: 'list' | 'grid') {
  try {
    globalThis.localStorage?.setItem(VIEW_MODE_STORAGE_KEY, mode)
  } catch {
    // best-effort UI persistence
  }
}

const IMAGE_EXTENSIONS = new Set([
  'apng',
  'avif',
  'gif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp',
])

const VIDEO_EXTENSIONS = new Set([
  'avi',
  'm4v',
  'mov',
  'mp4',
  'mpeg',
  'ogv',
  'webm',
])

function fileName(path: string) {
  return path.split('/').pop() ?? path
}

export function keyboardMenuPosition(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left + Math.min(rect.width - 8, 24),
    y: rect.top + Math.min(rect.height - 8, 24),
  }
}

function extension(path: string) {
  const name = fileName(path)
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index + 1).toLowerCase() : ''
}

/**
 * Classifies an asset as `'images'` or `'videos'`, or `null` when it is
 * neither — a non-media file (PDF, archive, etc.). The explorer only shows
 * real media, so `null` results are dropped at the bucketing/filtering step
 * rather than surfaced under a generic "Other" category.
 */
export function mediaBucket(mimeType: string | undefined, path: string): MediaBucket | null {
  if (mimeType?.startsWith('image/')) return 'images'
  if (mimeType?.startsWith('video/')) return 'videos'

  const ext = extension(path)
  if (IMAGE_EXTENSIONS.has(ext)) return 'images'
  if (VIDEO_EXTENSIONS.has(ext)) return 'videos'
  return null
}

export function groupCmsMediaAssets(assets: CmsMediaAsset[]) {
  const buckets: Record<MediaBucket, CmsMediaAsset[]> = {
    images: [],
    videos: [],
  }

  for (const asset of assets) {
    const bucket = mediaBucket(asset.mimeType, asset.filename)
    if (bucket) buckets[bucket].push(asset)
  }

  return buckets
}

function searchableText(...parts: Array<string | undefined>) {
  return parts.filter(Boolean).join(' ').toLowerCase()
}

function matchesSearch(query: string, ...parts: Array<string | undefined>) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return searchableText(...parts).includes(normalized)
}

export function filterCmsMediaBuckets(
  buckets: Record<MediaBucket, CmsMediaAsset[]>,
  filter: MediaFilter,
  query: string,
) {
  const next: Record<MediaBucket, CmsMediaAsset[]> = {
    images: [],
    videos: [],
  }

  for (const bucket of Object.keys(next) as MediaBucket[]) {
    if (filter !== 'all' && filter !== bucket) continue
    next[bucket] = buckets[bucket].filter((asset) => matchesSearch(query, asset.filename, asset.publicPath, asset.mimeType))
  }

  return next
}

export function targetBucket(target: CmsMediaAsset) {
  return mediaBucket(target.mimeType, target.filename)
}

/**
 * Compact "EXT · size" meta label shown under each media row/tile, e.g.
 * "PNG · 245 KB". The public path isn't useful at a glance here — it's
 * already one click away via the context menu's "Copy URL" — and crowding
 * the narrow panel with `/uploads/...` noise pushes out the size/type info
 * that's actually scannable.
 */
export function mediaMetaLabel(asset: CmsMediaAsset): string {
  const ext = extension(asset.filename).toUpperCase()
  const size = formatBytes(asset.sizeBytes)
  return ext ? `${ext} · ${size}` : size
}
