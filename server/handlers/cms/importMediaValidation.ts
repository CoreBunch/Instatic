/**
 * Byte-level security validation, SVG sanitisation, and write-destination
 * policy for imported media — the same gate the normal upload pipeline applies
 * via `acceptUploadedMedia`, re-applied on BOTH import paths (the JSON
 * `SiteBundle` import in `import.ts` and the archive import in
 * `importArchive.ts`) so neither can be used to smuggle unsanitised or
 * MIME-mismatched files onto disk, or to write media outside the media area.
 *
 * Two independent gates:
 *   - `validateAndSanitizeMediaBytes` — content: real MIME must match the
 *     declared type + extension, SVG is sanitised. Blocks writing HTML/JS
 *     (no accepted media MIME maps to a `.html`/`.js` extension).
 *   - `resolveMediaWriteTarget` — destination: no traversal, and never a
 *     reserved served subtree (`published/`, `plugins/`, `fonts/`).
 */
import { extname, join } from 'node:path'
import { assertPathWithin } from '../../util/pathWithin'
import { detectAcceptedMime, EXTENSION_FOR_MIME } from './mediaUpload'
import { sanitizeSvgBytes } from './svgSanitize'

/**
 * The fields both import payloads carry — the archive manifest media entry and
 * the JSON `SiteBundle` media asset both satisfy this shape.
 */
export interface ImportMediaDescriptor {
  storagePath: string
  mimeType: string
}

/**
 * Raised when an imported media entry fails a content or destination check.
 * Callers that need to distinguish this from other import errors can test
 * `instanceof ImportMediaValidationError`.
 */
export class ImportMediaValidationError extends Error {
  readonly storagePath: string
  constructor(message: string, storagePath: string) {
    super(message)
    this.name = 'ImportMediaValidationError'
    this.storagePath = storagePath
  }
}

/**
 * Top-level subtrees of the uploads dir that are served or executed as more
 * than inert `/uploads/*` media: the pre-rendered static site (served verbatim
 * as `text/html` with no CSP by the public router), plugin assets, and fonts.
 * Imported media must never land in these — otherwise a `data.import` caller
 * could overwrite a published page or a served plugin asset. Legitimate media
 * storagePaths are hashed filenames and never begin with these segments.
 */
const RESERVED_MEDIA_SUBTREES = new Set(['published', 'plugins', 'fonts'])

/**
 * Resolve and authorise the on-disk write target for an imported media asset.
 * Rejects traversal / absolute escapes (via `assertPathWithin`) and any path
 * whose first segment is a reserved served subtree. Returns the absolute
 * target path to write.
 */
export function resolveMediaWriteTarget(uploadsDir: string, storagePath: string): string {
  const firstSegment = storagePath.split('/', 1)[0]?.toLowerCase()
  if (firstSegment && RESERVED_MEDIA_SUBTREES.has(firstSegment)) {
    throw new ImportMediaValidationError(
      `Media storagePath "${storagePath}" targets the reserved "${firstSegment}" subtree; imported media may only be written to the media area`,
      storagePath,
    )
  }
  const target = join(uploadsDir, storagePath)
  assertPathWithin(uploadsDir, target)
  return target
}

/**
 * Validate and — for SVG — sanitize imported media bytes. This is the same
 * security gate the normal upload pipeline applies via `acceptUploadedMedia`.
 *
 * Algorithm:
 *   1. Detect the real MIME type from magic bytes (never trust the declared type).
 *   2. Reject if the detected type is unknown or differs from the declared type.
 *   3. Reject if the storagePath extension doesn't match the detected MIME
 *      (prevents extension laundering: e.g. SVG bytes stored as `.html` would
 *      be served as `text/html` by the static handler).
 *   4. For SVG: sanitize the bytes (strips <script>, foreignObject, on*
 *      handlers, javascript: URLs) and return the clean bytes.
 *
 * Returns the bytes that must be written to disk — either the original bytes
 * (non-SVG) or the sanitized replacement (SVG).
 */
export function validateAndSanitizeMediaBytes(
  bytes: Uint8Array,
  asset: ImportMediaDescriptor,
): Uint8Array {
  const detectedMime = detectAcceptedMime(bytes)
  if (!detectedMime) {
    throw new ImportMediaValidationError(
      `Media entry "${asset.storagePath}" has unrecognised file content; cannot verify MIME type`,
      asset.storagePath,
    )
  }

  if (detectedMime !== asset.mimeType) {
    throw new ImportMediaValidationError(
      `Media entry "${asset.storagePath}" declared as ${asset.mimeType} but bytes indicate ${detectedMime}`,
      asset.storagePath,
    )
  }

  // Verify the on-disk extension matches the server-trusted extension for the
  // detected MIME. The static handler maps file extension → Content-Type, so a
  // mismatched extension (e.g. correct SVG bytes named `exploit.html`) would
  // override the DB row's mimeType when the file is served.
  const expectedExt = EXTENSION_FOR_MIME[detectedMime as keyof typeof EXTENSION_FOR_MIME]
  const actualExt = extname(asset.storagePath).toLowerCase()
  if (expectedExt && actualExt !== expectedExt) {
    throw new ImportMediaValidationError(
      `Media entry "${asset.storagePath}" has extension "${actualExt}" but detected MIME ${detectedMime} requires "${expectedExt}"`,
      asset.storagePath,
    )
  }

  if (detectedMime === 'image/svg+xml') {
    const sanitized = sanitizeSvgBytes(bytes)
    if (sanitized.length === 0) {
      throw new ImportMediaValidationError(
        `Media entry "${asset.storagePath}" is empty after SVG sanitisation (likely contains only disallowed elements)`,
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
