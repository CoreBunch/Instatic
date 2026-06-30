// Shared media-explorer vocabulary: the bucket/filter/view-mode types and the
// human-facing bucket labels. Kept free of React and DOM so both the panel
// container and its sub-components can import from one place.
//
// The explorer only ever shows real media (images/videos) — non-media files
// (PDFs, archives, etc.) are filtered out at the bucketing step rather than
// surfaced under a generic "Other" category. See `mediaBucket` in
// `mediaExplorerUtils.ts`.

export type MediaBucket = 'images' | 'videos'
export type MediaFilter = 'all' | MediaBucket
export type MediaViewMode = 'list' | 'grid'

export const BUCKET_LABELS: Record<MediaBucket, string> = {
  images: 'Images',
  videos: 'Videos',
}
