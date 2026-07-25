/**
 * `html` tagged template — the safe-by-default render helper.
 *
 *   import { html } from '@instatic/plugin-sdk'
 *
 *   render: ({ props }) => html`
 *     <aside class="callout">
 *       <strong>${props.title}</strong>
 *       ${props.body}
 *     </aside>
 *   `
 *
 * Every interpolation is HTML-escaped automatically — no `escape()` calls in
 * the body. To opt out for already-safe markup (e.g. nested `render()`
 * output), wrap with `raw(s)`.
 *
 * Arrays of values are joined; `null` / `undefined` render as empty strings.
 * Numbers and booleans are stringified. Objects with `__raw` are emitted
 * verbatim (used by `raw()`).
 */
import { isSafeUrl } from '@core/html-sanitize'

const HTML_ESCAPE_RE = /[&<>"']/g
const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch])
}

const RAW_BRAND = Symbol.for('@instatic/plugin-sdk/raw')

interface RawHtml {
  [RAW_BRAND]: true
  value: string
}

function isRawHtml(value: unknown): value is RawHtml {
  return Boolean(value) && typeof value === 'object' && (value as RawHtml)[RAW_BRAND] === true
}

/** Mark a string as already-safe HTML so the `html` tag emits it verbatim. */
export function raw(value: string): RawHtml {
  return { [RAW_BRAND]: true, value }
}

function renderInterpolation(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return escapeHtml(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (isRawHtml(value)) return value.value
  if (Array.isArray(value)) return value.map(renderInterpolation).join('')
  // Anything else (plain objects, functions): coerce + escape, but warn —
  // plugin authors almost certainly didn't mean to interpolate `[object Object]`.
  console.warn('[plugin-sdk:html] Unsupported interpolation type', typeof value, value)
  return escapeHtml(String(value))
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = ''
  for (let i = 0; i < strings.length; i++) {
    out += strings[i]
    if (i < values.length) out += renderInterpolation(values[i])
  }
  return out
}

/**
 * Validate a URL value before emitting it into an `href`/`src`/`action`.
 * Returns `'#'` for anything outside the shared scheme allowlist. Use inside
 * `html`:
 *
 *   html`<a href="${safeUrl(props.href)}">…</a>`
 *
 * Delegates to the canonical guard rather than carrying its own scheme logic —
 * this used to be an independent two-regex denylist that a plain leading space
 * defeated and that never blocked `data:` at all (GHSA-pqcp-872g-gmp8).
 *
 * Does not HTML-escape, unlike `safeUrl` in `@core/html-sanitize`: the `html`
 * tag already escapes every interpolation, so escaping here double-encodes `&`.
 */
export function safeUrl(value: unknown): string {
  const s = String(value ?? '')
  return isSafeUrl(s) ? s : '#'
}
