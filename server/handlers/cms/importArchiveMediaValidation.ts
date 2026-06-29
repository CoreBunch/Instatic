/**
 * Byte-level security validation and SVG sanitisation for archive media
 * entries — the same gate the normal upload pipeline applies via
 * `acceptUploadedMedia`, re-applied here so the archive import path cannot be
 * used to smuggle unsanitised or MIME-mismatched files onto disk.
 *
 * Extracted from importArchive.ts to keep each module under the 700-line cap.
 */
import { extname } from 'node:path'
import { detectAcceptedMime, EXTENSION_FOR_MIME } from './mediaUpload'
import { sanitizeSvgBytes } from './svgSanitize'
import type { SiteBundleArchiveManifest } from '@core/data/bundleArchive'

/**
 * Raised when a staged archive media entry fails the byte-level security
 * checks. Callers that need to distinguish this from archive structural
 * errors can test `instanceof ArchiveMediaValidationError`.
 */
export class ArchiveMediaValidationError extends Error {
  readonly storagePath: string
  constructor(message: string, storagePath: string) {
    super(message)
    this.name = 'ArchiveMediaValidationError'
    this.storagePath = storagePath
  }
}

/**
 * Validate and — for SVG — sanitize the bytes of a staged archive media
 * entry.  This is the same security gate the normal upload pipeline applies
 * via `acceptUploadedMedia`, re-applied here so the archive import path
 * cannot be used to smuggle unsanitized or MIME-mismatched files onto disk.
 *
 * Algorithm:
 *   1. Detect the real MIME type from magic bytes (never trust the manifest).
 *   2. Reject if the detected type is unknown or differs from the manifest.
 *   3. Reject if the storagePath extension doesn't match the detected MIME
 *      (prevents extension laundering: e.g. SVG bytes stored as .html would
 *      be served as text/html by the static handler).
 *   4. For SVG: sanitize the bytes (strips <script>, foreignObject, on*
 *      handlers, javascript: URLs) and return the clean bytes.
 *
 * Returns the bytes that must be written to disk — either the original bytes
 * (non-SVG) or the sanitized replacement (SVG).
 */
export async function validateAndSanitizeMediaBytesForImport(
  stagedPath: string,
  asset: NonNullable<SiteBundleArchiveManifest['media']>[number],
): Promise<Uint8Array> {
  const raw = await Bun.file(stagedPath).arrayBuffer()
  const bytes = new Uint8Array(raw)

  const detectedMime = detectAcceptedMime(bytes)
  if (!detectedMime) {
    throw new ArchiveMediaValidationError(
      `Archive media entry "${asset.storagePath}" has unrecognised file content; cannot verify MIME type`,
      asset.storagePath,
    )
  }

  if (detectedMime !== asset.mimeType) {
    throw new ArchiveMediaValidationError(
      `Archive media entry "${asset.storagePath}" declared as ${asset.mimeType} but bytes indicate ${detectedMime}`,
      asset.storagePath,
    )
  }

  // Verify the on-disk extension matches the server-trusted extension for the
  // detected MIME. This closes the extension-laundering attack surface where an
  // entry correctly declares image/svg+xml but names the file "exploit.html" —
  // the static handler maps file extension → Content-Type, so a mismatched
  // extension overrides the DB row's mimeType when the file is served.
  const expectedExt = EXTENSION_FOR_MIME[detectedMime as keyof typeof EXTENSION_FOR_MIME]
  const actualExt = extname(asset.storagePath).toLowerCase()
  if (expectedExt && actualExt !== expectedExt) {
    throw new ArchiveMediaValidationError(
      `Archive media entry "${asset.storagePath}" has extension "${actualExt}" but detected MIME ${detectedMime} requires "${expectedExt}"`,
      asset.storagePath,
    )
  }

  if (detectedMime === 'image/svg+xml') {
    const sanitized = sanitizeSvgBytes(bytes)
    if (sanitized.length === 0) {
      throw new ArchiveMediaValidationError(
        `Archive media entry "${asset.storagePath}" is empty after SVG sanitisation (likely contains only disallowed elements)`,
        asset.storagePath,
      )
    }
    // Return a fresh ArrayBuffer-backed view (TextEncoder output is typed
    // against the looser ArrayBufferLike; the rest of the write path expects
    // Uint8Array<ArrayBuffer>).
    return new Uint8Array(sanitized)
  }

  return bytes
}
