export type MediaViewMode = 'list' | 'grid'

const MEDIA_VIEW_MODE_STORAGE_KEY = 'instatic-media-page-view-mode'

export function readStoredMediaViewMode(): MediaViewMode {
  try {
    const raw = globalThis.localStorage?.getItem(MEDIA_VIEW_MODE_STORAGE_KEY)
    return raw === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

export function writeStoredMediaViewMode(mode: MediaViewMode) {
  try {
    globalThis.localStorage?.setItem(MEDIA_VIEW_MODE_STORAGE_KEY, mode)
  } catch {
    // View preference persistence is best-effort.
  }
}
