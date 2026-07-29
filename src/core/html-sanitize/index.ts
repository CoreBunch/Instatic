/**
 * HTML and URL sanitisation leaf.
 *
 * Pure helpers shared by publisher, markdown rendering, module render helpers,
 * and server-side HTML injection code. This module deliberately depends on
 * nothing in the publisher so lower-level renderers can use the same escaping
 * rules without pulling in the whole publishing engine.
 */

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
}

/**
 * HTML-escape the five characters that are dangerous in HTML text and
 * attribute contexts. Non-strings are stringified for module render helpers
 * that receive prop values as unknown.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch])
}

/**
 * Schemes safe to place in an `href` / `src` / `action`. Everything else —
 * including `javascript:`, `vbscript:`, `data:`, `blob:`, `file:` and any
 * custom app scheme — is rejected. Relative URLs carry no scheme at all and
 * are always allowed.
 */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:'])

/**
 * Schemes that execute script or substitute a whole document, and so must not
 * survive into ANY rendered attribute value — URL-bearing or not.
 */
const DANGEROUS_URL_SCHEMES = new Set(['javascript:', 'vbscript:', 'data:'])

/**
 * Extract the scheme the way the WHATWG URL parser does, so this guard cannot
 * disagree with the browser that ultimately resolves the value:
 *
 *   1. strip leading and trailing C0 controls and space (U+0000–U+0020);
 *   2. remove every ASCII tab / LF / CR from anywhere in the string;
 *   3. read `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"` off the front.
 *
 * Step 1 is what the previous implementation got wrong: it used
 * `String.prototype.trim()`, which strips only U+0009–U+000D, U+0020 and the
 * Unicode space separators — leaving U+0000–U+0008 and U+000E–U+001F in place.
 * A browser strips all of them, so `"javascript:…"` read as safe here
 * while resolving to the `javascript:` scheme in the page (GHSA-pqcp-872g-gmp8).
 *
 * Returns the lowercased scheme including its colon, or `null` when the value
 * carries no scheme — a relative URL, or ordinary prose.
 *
 * Deliberately does NOT use `new URL()`. This module is bundled into plugin
 * module packs that execute inside the QuickJS-WASM sandbox, whose `URL`
 * polyfill (`server/plugins/quickjs/bootstrap/`) is a regex approximation that
 * requires `scheme://authority` and strips no control characters. A pure-string
 * implementation behaves identically in Bun, in browsers, and in the sandbox.
 */
export function urlScheme(value: string): string | null {
  // Matching control characters is the entire point of this function — the C0
  // range is what the URL parser strips and what the old `trim()`-based guard
  // missed, so `no-control-regex` is inverted here.
  /* eslint-disable no-control-regex */
  const normalized = value
    .replace(/^[\u0000-\u0020]+/, '')
    .replace(/[\u0000-\u0020]+$/, '')
    .replace(/[\t\n\r]/g, '')
  /* eslint-enable no-control-regex */
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalized)
  return match ? `${match[1].toLowerCase()}:` : null
}

/**
 * Return true when a URL is safe for an href/src/action attribute.
 *
 * Allowlist: http, https, mailto, tel, sms, plus every relative form
 * (`/a`, `./a`, `../a`, `a.html`, `#anchor`, `?q=1`, `//cdn.example/x`, `''`).
 */
export function isSafeUrl(url: string): boolean {
  const scheme = urlScheme(String(url ?? ''))
  return scheme === null || SAFE_URL_SCHEMES.has(scheme)
}

/**
 * Return true when an arbitrary attribute VALUE — which may be prose, an ARIA
 * label, a `viewBox`, or a URL — carries a scheme that executes script or
 * substitutes a document.
 *
 * This is the predicate for the custom-`htmlAttributes` gate, which checks every
 * attribute value regardless of whether the attribute is URL-bearing. It cannot
 * use `isSafeUrl`: `title="Notes: draft"` parses as scheme `notes:` and must
 * survive, while `javascript:` under any control-character disguise must not.
 */
export function hasDangerousUrlScheme(value: string): boolean {
  const scheme = urlScheme(String(value ?? ''))
  return scheme !== null && DANGEROUS_URL_SCHEMES.has(scheme)
}

/**
 * Validate a URL and HTML-escape it for safe interpolation into an attribute
 * inside a template string. Unsafe values collapse to "#".
 *
 * Do NOT use at a React prop boundary — React escapes on its own, so escaping
 * here double-encodes `&`. Use `isSafeUrl(v) ? v : '#'` there instead.
 */
export function safeUrl(value: unknown): string {
  const str = String(value ?? '')
  if (!isSafeUrl(str)) return '#'
  return escapeHtml(str)
}
