/**
 * Media repository domain types.
 *
 * Kept outside the CRUD repository and row mapper so both can share the same
 * asset shape without importing each other.
 */

export interface MediaVariant {
  width: number
  height: number
  format: 'webp' | 'jpeg' | 'png' | 'avif'
  /**
   * Public URL the renderer emits (`/uploads/<storage>` for local; an absolute
   * URL for public external storage; local route again for redirect/proxy modes).
   */
  path: string
  sizeBytes: number
  /** Adapter-internal storage handle. */
  storagePath: string
  /** Adapter id that wrote this variant; `''` for the built-in local adapter. */
  storageAdapterId: string
}

/**
 * Non-destructive crop rectangle, expressed as fractions of the ORIGINAL
 * image (0–1, `x + width <= 1`, `y + height <= 1`).
 *
 * Fractions rather than pixels on purpose: the rectangle stays meaningful if
 * the same crop is ever re-applied to a re-encoded original, and the UI works
 * in the same units the overlay drags in. The original bytes are never
 * rewritten — the crop is baked into the responsive variants, so dropping the
 * rectangle and regenerating restores the full frame.
 */
export interface MediaCrop {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Editorial focus area — an ellipse marking the subject that must stay visible
 * when a CONTAINER crops the image at render time (`object-fit: cover`), as
 * opposed to `MediaCrop`, which bakes pixels away for good.
 *
 * Fractions of the ORIGINAL image, the same space as the crop rectangle, so
 * moving the crop doesn't silently move the focus. `x`/`y` are the ellipse
 * CENTRE, `width`/`height` its full extent. Null = dead centre.
 *
 * The centre is what becomes `object-position` on the published page. The
 * extent records editorial intent — "the subject is this big" — so the crop UI
 * can draw it and so per-ratio art-directed variants have something to aim at.
 * ponytail: extent is stored but has no publish-time consumer yet; the
 * consumer would be an aspect-aware variant ladder in the image worker.
 */
export interface MediaFocus {
  x: number
  y: number
  width: number
  height: number
}

export interface MediaAsset {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  publicPath: string
  uploadedByUserId: string | null
  createdAt: string
  altText: string
  caption: string
  title: string
  tags: string[]
  width: number | null
  height: number | null
  durationMs: number | null
  dominantColor: string | null
  deletedAt: string | null
  replacedAt: string | null
  folderIds: string[]
  blurHash: string | null
  variants: MediaVariant[]
  /** Applied crop, or null when the asset shows its full frame. */
  crop: MediaCrop | null
  /** Editorial focal point, or null for centre. */
  focus: MediaFocus | null
  posterPath: string | null
  /** Empty string for the built-in local-disk adapter. */
  storageAdapterId: string
  /** True when bytes live outside the host uploads dir. */
  externallyHosted: boolean
}
