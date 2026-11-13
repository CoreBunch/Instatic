/**
 * Whitelist of media MIMEs we accept — keys are the canonical MIME, values
 * are the server-chosen on-disk extension. The static handler maps file
 * extension → Content-Type, so picking the extension here is what guarantees
 * the served Content-Type.
 *
 * SVG is allowed but goes through DOMPurify (SVG profile) before storage so
 * any `<script>`, foreignObject, or javascript:/data: URLs are stripped.
 * Fonts are static binaries with reliable magic bytes and no script surface.
 *
 * Notably absent: `application/pdf` (browsers may render PDFs inline with
 * embedded JS), anything HTML/CSS/JS adjacent.
 */
export const EXTENSION_FOR_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  // Web fonts — referenced from @font-face inside imported stylesheets. All
  // four formats are pure binary containers with no script surface; magic
  // bytes are reliable per the OpenType / WOFF specs.
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
} as const

export type AcceptedMediaMime = keyof typeof EXTENSION_FOR_MIME

/**
 * Magic-byte signatures for each accepted MIME. Each signature is a list of
 * `(offset, byte)` constraints — the file passes the signature if every
 * constraint is satisfied. Some formats (WebP, MP4) need non-contiguous
 * checks (`RIFF....WEBP`, `....ftyp`), hence the offset list rather than a
 * single contiguous prefix match.
 */
type MagicConstraint = readonly [offset: number, byte: number]

const MEDIA_MAGIC_SIGNATURES: ReadonlyArray<{
  mime: AcceptedMediaMime
  bytes: ReadonlyArray<MagicConstraint>
}> = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  { mime: 'image/png', bytes: [[0, 0x89], [1, 0x50], [2, 0x4e], [3, 0x47], [4, 0x0d], [5, 0x0a], [6, 0x1a], [7, 0x0a]] },
  // JPEG: FF D8 FF (SOI marker followed by any APPx marker)
  { mime: 'image/jpeg', bytes: [[0, 0xff], [1, 0xd8], [2, 0xff]] },
  // GIF87a / GIF89a
  { mime: 'image/gif', bytes: [[0, 0x47], [1, 0x49], [2, 0x46], [3, 0x38], [4, 0x37], [5, 0x61]] },
  { mime: 'image/gif', bytes: [[0, 0x47], [1, 0x49], [2, 0x46], [3, 0x38], [4, 0x39], [5, 0x61]] },
  // WebP: RIFF<size>WEBP — bytes 0..3 = RIFF, bytes 8..11 = WEBP
  { mime: 'image/webp', bytes: [[0, 0x52], [1, 0x49], [2, 0x46], [3, 0x46], [8, 0x57], [9, 0x45], [10, 0x42], [11, 0x50]] },
  // AVIF: ISO Base Media `ftyp` box with `avif` as the major brand. Keep this
  // before MP4: MP4's broader `ftyp` signature also matches every AVIF file.
  { mime: 'image/avif', bytes: [[4, 0x66], [5, 0x74], [6, 0x79], [7, 0x70], [8, 0x61], [9, 0x76], [10, 0x69], [11, 0x66]] },
  // MP4 / ISO Base Media: `ftyp` box at offset 4..7. The first 4 bytes are
  // the box size which varies; only the type identifier matters here.
  { mime: 'video/mp4', bytes: [[4, 0x66], [5, 0x74], [6, 0x79], [7, 0x70]] },
  // WebM: EBML header 1A 45 DF A3 (also Matroska — close enough for us;
  // the content-type we serve is video/webm regardless and browsers will
  // refuse to play non-webm Matroska, which is the desired outcome).
  { mime: 'video/webm', bytes: [[0, 0x1a], [1, 0x45], [2, 0xdf], [3, 0xa3]] },

  // WOFF: 77 4F 46 46 ("wOFF") per W3C WOFF1 §3.
  { mime: 'font/woff', bytes: [[0, 0x77], [1, 0x4f], [2, 0x46], [3, 0x46]] },
  // WOFF2: 77 4F 46 32 ("wOF2") per W3C WOFF2 §3.
  { mime: 'font/woff2', bytes: [[0, 0x77], [1, 0x4f], [2, 0x46], [3, 0x32]] },
  // TTF / TrueType: 00 01 00 00 (sfnt scaler type) OR "true" / "ttcf" (rare).
  { mime: 'font/ttf', bytes: [[0, 0x00], [1, 0x01], [2, 0x00], [3, 0x00]] },
  { mime: 'font/ttf', bytes: [[0, 0x74], [1, 0x72], [2, 0x75], [3, 0x65]] }, // "true"
  // OTF / OpenType with CFF outlines: 4F 54 54 4F ("OTTO") per OpenType §6.
  { mime: 'font/otf', bytes: [[0, 0x4f], [1, 0x54], [2, 0x54], [3, 0x4f]] },
]

/**
 * SVG is text-based (XML), not a magic-byte format, so it can't be detected
 * by the binary sniffer above. Decode the first ~512 bytes as UTF-8 and look
 * for the XML prolog or a top-level `<svg` opening tag, allowing an optional
 * BOM and leading whitespace. Returns `'image/svg+xml'` when matched.
 *
 * This is intentionally lenient — the **security** boundary is the
 * subsequent DOMPurify pass (SVG profile) which strips `<script>`,
 * `<foreignObject>`, `javascript:` / `data:` URLs, and on-* handlers
 * regardless of how the file claims to be structured.
 */
function detectSvgMime(bytes: Uint8Array): AcceptedMediaMime | null {
  // Decode the first 512 bytes; bigger files just look at the prefix.
  const slice = bytes.subarray(0, Math.min(bytes.length, 512))
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })
  const head = decoder.decode(slice).trimStart()
  if (head.startsWith('<?xml') || head.startsWith('<svg')) {
    return 'image/svg+xml'
  }
  return null
}

export function detectAcceptedMime(bytes: Uint8Array): AcceptedMediaMime | null {
  for (const sig of MEDIA_MAGIC_SIGNATURES) {
    let matches = true
    for (const [offset, expected] of sig.bytes) {
      if (offset >= bytes.length || bytes[offset] !== expected) {
        matches = false
        break
      }
    }
    if (matches) return sig.mime
  }
  // Fallback to text-based detection for SVG — checked LAST so a corrupted
  // binary file that happens to start with `<svg` can't be misidentified;
  // the binary signatures above would have matched first if the bytes were
  // actually a binary format.
  return detectSvgMime(bytes)
}
