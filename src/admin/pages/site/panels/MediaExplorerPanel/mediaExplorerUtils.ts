// Pure, side-effect-free helpers for the Media Explorer: view-mode
// persistence, filename/extension parsing, MIME/extension bucketing, and
// search/filter over the loaded asset list. No JSX, no React, no store access.

import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import type { MediaBucket, MediaFilter } from './mediaExplorerModel'

const VIEW_MODE_STORAGE_KEY = 'instatic-media-explorer-view-mode'

export function readStoredViewMode(): 'list' | 'grid' {
  try {
    const raw = globalThis.localStorage?.getItem(VIEW_MODE_STORAGE_KEY)
    return raw === 'grid' || raw === 'list' ? raw : 'list'
  } catch {
    return 'list'
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

export function mediaBucket(mimeType: string | undefined, path: string): MediaBucket {
  if (mimeType?.startsWith('image/')) return 'images'
  if (mimeType?.startsWith('video/')) return 'videos'

  const ext = extension(path)
  if (IMAGE_EXTENSIONS.has(ext)) return 'images'
  if (VIDEO_EXTENSIONS.has(ext)) return 'videos'
  return 'other'
}

export function groupCmsMediaAssets(assets: CmsMediaAsset[]) {
  const buckets: Record<MediaBucket, CmsMediaAsset[]> = {
    images: [],
    videos: [],
    other: [],
  }

  for (const asset of assets) {
    buckets[mediaBucket(asset.mimeType, asset.filename)].push(asset)
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
    other: [],
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
