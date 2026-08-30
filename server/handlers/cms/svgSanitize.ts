/**
 * Server-side SVG sanitizer for imported / uploaded media.
 *
 * SVG is XML with a script surface: `<script>` and `<foreignObject>` elements,
 * `on*` event handlers, `javascript:` URLs, and namespace-prefixed variants of
 * all of them. Anything stored in the media library is served as
 * `image/svg+xml` and can be embedded inline (`<img src=…>` or directly) in
 * published pages, so a malicious payload would execute in the publisher's
 * origin.
 *
 * We run DOMPurify's SVG profile over the decoded bytes via `sanitizeSvg`.
 * DOMPurify parses the input as a real namespaced DOM, so a namespace-prefixed
 * script element (`<s:script>`), an entity-encoded `javascript:` scheme, or an
 * `<animate>` that rewrites an `xlink:href` are all neutralised. A literal-tag
 * regex denylist cannot catch these over XML, because XML identifies an element
 * by its namespace, not its prefix (GHSA-5h25). The server runs DOMPurify on
 * jsdom (see `server/richtextSanitizer.ts`); the same profile handles inline
 * SVG props at the publisher boundary, so upload and render stay aligned.
 *
 * Defense in depth: the sanitised bytes are what hit disk AND what the browser
 * receives. Served assets also carry hardened headers; this sanitiser is the
 * content-level guard.
 */

import { sanitizeSvg } from '@core/sanitize'

/**
 * Sanitize an SVG byte buffer and return the re-encoded clean bytes.
 *
 * Decoding policy: UTF-8, BOM-tolerant, never throws on malformed input.
 * Re-encoding policy: UTF-8 without BOM.
 *
 * Returns empty bytes when the input decodes to an empty / whitespace string,
 * or when sanitisation leaves nothing behind — the caller treats empty bytes as
 * "invalid SVG" and rejects the upload.
 */
export function sanitizeSvgBytes(bytes: Uint8Array): Uint8Array {
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })
  const original = decoder.decode(bytes)
  if (original.trim().length === 0) return new Uint8Array(0)

  const cleaned = sanitizeSvg(original)

  if (cleaned.trim().length === 0) return new Uint8Array(0)
  return new TextEncoder().encode(cleaned)
}
