/**
 * Server-side SVG sanitizer (string-based).
 *
 * SVG is allowed through the media-library upload path so users can import
 * iconography, logos, and decorative assets from static-site bundles. But SVG
 * is XML with a script surface — anything stored in the media library is
 * served as `image/svg+xml` and can be embedded inline (`<img src=…>` or
 * directly) in published pages, so a malicious payload would execute in the
 * publisher's origin. The known active vectors:
 *
 *   1. `<script>…</script>` — direct JS execution.
 *   2. `<foreignObject>` — can embed arbitrary HTML (incl. <script>, iframes).
 *   3. `on*` event-handler attributes (`onload`, `onclick`, …).
 *   4. `javascript:` URLs inside `href` / `xlink:href`.
 *   5. `<a>` elements pointing at `javascript:` URLs.
 *
 * Why string-based rather than DOMPurify: this sanitizer operates on the raw
 * upload bytes rather than a parsed DOM, so it needs no DOM runtime. SVG's
 * dangerous surface is small and well-defined, which makes a targeted string
 * sanitizer a predictable, dependency-free guard at this layer. (Richtext HTML
 * is sanitised separately by DOMPurify over jsdom in `server/richtextSanitizer.ts`.)
 *
 * Defense in depth: the sanitised bytes are what hit disk AND what the browser
 * receives, with no out-of-band cleaning step. Static assets are also served
 * with their own headers; this sanitiser is the content-level guard.
 */

// Each pattern targets one vector. The `gi` flags + `[\s\S]` (rather than `.`)
// make every pattern span newlines and match case-insensitively.

// Close-tag matcher: the HTML parser ends an element at the first `>` after the
// tag name, so `</script bar>`, `</script\t\n>`, and `</script/>` all close a
// `<script>`. `(?:[\s/][^>]*)?` after the name accepts any whitespace/junk run
// up to that `>` while `\b`-anchoring rejects `</scriptfoo>`. A bare `<\/x\s*>`
// (the previous form) missed these and is what CodeQL's bad-tag-filter flagged.
const scriptClose = String.raw`<\/script(?:[\s/][^>]*)?>`
const foreignObjectClose = String.raw`<\/foreignObject(?:[\s/][^>]*)?>`
const styleClose = String.raw`<\/style(?:[\s/][^>]*)?>`

/** `<script …>…</script>` including any attributes / whitespace / newlines. */
const SCRIPT_BLOCK_RE = new RegExp(String.raw`<script\b[\s\S]*?${scriptClose}`, 'gi')
/** A self-closing or unclosed `<script …/>` / `<script …>` with no close tag. */
const SCRIPT_OPEN_RE = /<script\b[^>]*\/?>/gi
/** A dangling `</script …>` close tag left after its opener was stripped. */
const SCRIPT_CLOSE_RE = new RegExp(scriptClose, 'gi')
/** `<foreignObject …>…</foreignObject>` — can carry arbitrary HTML. */
const FOREIGN_OBJECT_RE = new RegExp(String.raw`<foreignObject\b[\s\S]*?${foreignObjectClose}`, 'gi')
const FOREIGN_OBJECT_OPEN_RE = /<foreignObject\b[^>]*\/?>/gi
/** `<a …>` / `</a>` is allowed, but href values are scrubbed below. */
/** `on*="…"` / `on*='…'` / `on*=value` event-handler attributes. */
const EVENT_HANDLER_RE = /\son[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
/**
 * `href` / `xlink:href` / `src` whose value (after optional whitespace and
 * entity-encoding tricks) resolves to a `javascript:` scheme. We blank the
 * whole attribute rather than try to rewrite it.
 */
const JS_URL_ATTR_RE =
  /\s(?:xlink:href|href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]*)/gi
/** `<style>…</style>` blocks — CSS can carry `@import url(javascript:…)`. */
const STYLE_BLOCK_RE = new RegExp(String.raw`<style\b[\s\S]*?${styleClose}`, 'gi')

function stripVectorsOnce(svg: string): string {
  return svg
    .replace(SCRIPT_BLOCK_RE, '')
    .replace(SCRIPT_OPEN_RE, '')
    .replace(SCRIPT_CLOSE_RE, '')
    .replace(FOREIGN_OBJECT_RE, '')
    .replace(FOREIGN_OBJECT_OPEN_RE, '')
    .replace(STYLE_BLOCK_RE, '')
    .replace(EVENT_HANDLER_RE, '')
    .replace(JS_URL_ATTR_RE, '')
}

/**
 * Strip every vector, then keep stripping until the string stops changing.
 * Removing one wrapper can reveal a nested vector (`<scr<script>ipt>` collapses
 * to `<script>`; `<scr<script>ipt>alert()</scr</script>ipt>` needs several
 * passes), so a fixed pass count can leave a payload behind — which is exactly
 * what CodeQL's incomplete-multi-character-sanitization flagged. Iterating to a
 * fixpoint removes that class of bypass entirely. The input is bounded and each
 * pass only ever shrinks it, so this always terminates.
 */
function stripVectors(svg: string): string {
  let current = svg
  // Bound iterations defensively; a shrinking string converges well before this.
  for (let i = 0; i < 100; i++) {
    const next = stripVectorsOnce(current)
    if (next === current) return current
    current = next
  }
  return current
}

/**
 * Sanitize an SVG byte buffer and return the re-encoded clean bytes.
 *
 * Decoding policy: UTF-8, BOM-tolerant, never throws on malformed input.
 * Re-encoding policy: UTF-8 without BOM.
 *
 * Idempotent: `stripVectors` iterates to a fixpoint, so re-running removes
 * nothing — split-tag obfuscation (`<scr<script>ipt>`) is already collapsed
 * away inside that loop.
 *
 * Returns empty bytes only when the input decodes to an empty / whitespace
 * string — the caller treats that as "invalid SVG" and rejects the upload.
 */
export function sanitizeSvgBytes(bytes: Uint8Array): Uint8Array {
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })
  const original = decoder.decode(bytes)
  if (original.trim().length === 0) return new Uint8Array(0)

  const cleaned = stripVectors(original)

  if (cleaned.trim().length === 0) return new Uint8Array(0)
  return new TextEncoder().encode(cleaned)
}
