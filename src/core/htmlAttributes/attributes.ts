import { hasDangerousUrlScheme } from '@core/html-sanitize'

const HTML_ATTRIBUTE_NAME_RE = /^[a-z][a-z0-9_.:-]*$/i
const RESERVED_DATA_PREFIX_RE = /^data-(instatic|canvas)-/i
const RESERVED_DATA_NAMES = new Set([
  'data-node-id',
  'data-module-id',
  'data-hovered',
])
const RESERVED_HTML_ATTRIBUTE_NAMES = new Set(['class', 'style'])

/**
 * Attribute names that inject a raw HTML document / script and therefore cannot
 * be made safe by a URL-scheme check: `srcdoc` runs its value as an `<iframe>`
 * document, executing any `<script>` inside it on load. URL-bearing attributes
 * (`href`, `src`, `formaction`, `xlink:href`, …) are handled by the
 * value-level `hasDangerousUrlScheme` check in `sanitizeRenderableHtmlAttribute`
 * instead of a name denylist, so new URL attributes are covered without
 * enumerating them.
 */
const RAW_HTML_SINK_ATTRIBUTE_NAMES = new Set(['srcdoc'])

export function normalizeHtmlAttributeName(name: string): string {
  return name.trim().toLowerCase()
}

export function isReservedRuntimeDataAttributeName(name: string): boolean {
  const normalised = normalizeHtmlAttributeName(name)
  return RESERVED_DATA_PREFIX_RE.test(normalised) || RESERVED_DATA_NAMES.has(normalised)
}

export function isEventHandlerAttributeName(name: string): boolean {
  return /^on[a-z]/i.test(normalizeHtmlAttributeName(name))
}

export function isRenderableHtmlAttributeName(name: string): boolean {
  const normalised = normalizeHtmlAttributeName(name)
  return (
    HTML_ATTRIBUTE_NAME_RE.test(normalised) &&
    !RESERVED_HTML_ATTRIBUTE_NAMES.has(normalised) &&
    !RAW_HTML_SINK_ATTRIBUTE_NAMES.has(normalised) &&
    !isEventHandlerAttributeName(normalised) &&
    !isReservedRuntimeDataAttributeName(normalised)
  )
}

/**
 * The single security gate every custom-`htmlAttributes` emit path funnels
 * through — the publisher string emit (`htmlAttributesAttr`), the admin-canvas
 * React props (`htmlAttributesForReact`), the `<body>` emit
 * (`bodyHtmlAttributes`), and the HTML-import harvest (`collectHtmlAttributes`).
 *
 * Returns the value to render, or `null` to drop the attribute entirely. Drops:
 *   - non-renderable / event-handler / reserved / raw-HTML-sink names
 *     (via `isRenderableHtmlAttributeName`);
 *   - values carrying a dangerous URL scheme — `javascript:` / `vbscript:` /
 *     `data:` (via `hasDangerousUrlScheme`). This blocks e.g. a custom
 *     `href="javascript:…"` that would otherwise shadow a module's own checked
 *     href and execute in the page — on the published site AND, more
 *     seriously, inside the admin editor canvas (same-origin as `/admin`).
 *
 * `hasDangerousUrlScheme` is deliberately used here rather than `isSafeUrl`:
 * this gate sees EVERY attribute value, not just URL-bearing ones, and
 * `isSafeUrl` is an allowlist that would drop ordinary prose (`title="Notes:
 * draft"` parses as scheme `notes:`). Only genuinely executable schemes are
 * rejected, so titles, ARIA labels and `viewBox` pass through unchanged.
 */
export function sanitizeRenderableHtmlAttribute(name: string, value: string): string | null {
  if (!isRenderableHtmlAttributeName(name)) return null
  if (hasDangerousUrlScheme(value)) return null
  return value
}

/**
 * Normalise a raw `htmlAttributes` prop bag into render-safe attributes:
 * non-string values are dropped, names run through
 * `normalizeHtmlAttributeName`, and every value through
 * `sanitizeRenderableHtmlAttribute`. Both emit paths — the publisher string
 * emit (`htmlAttributesAttr` in `@core/publisher`) and the admin-canvas
 * React props (`htmlAttributesForReact`) — build on this.
 */
export function normalizeHtmlAttributes(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const attrs: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== 'string') continue
    const name = normalizeHtmlAttributeName(rawName)
    const safeValue = sanitizeRenderableHtmlAttribute(name, rawValue)
    if (safeValue === null) continue
    attrs[name] = safeValue
  }
  return attrs
}

/** Author `htmlAttributes` as React-spreadable props for canvas editors. */
export function htmlAttributesForReact(value: unknown): Record<string, string> {
  return normalizeHtmlAttributes(value)
}
