/**
 * Publisher — prop escaping (Constraint #211)
 *
 * Every string prop is escaped BEFORE being handed to a module's pure
 * render() function. The escaper for each prop is chosen by the prop's
 * declared control `type` in the module's `PropertySchema` — NOT by guessing
 * from the prop's key name. Routing by name is a shadow type-system that
 * silently mis-escapes any prop whose name misses the heuristic (a
 * `richtext`-typed `pageBody` HTML-escaped instead of sanitised → broken
 * markup AND unsanitised stored XSS; a `url`-typed `assetPath` escaped instead
 * of scheme-checked → `javascript:` not blocked). The schema already knows the
 * type, so we dispatch on it.
 *
 * Four categories with distinct rules:
 *
 * - URL-typed props (`type: 'url' | 'image' | 'media'`):
 *   validated by isSafeUrl() to neutralise `javascript:` / `vbscript:` /
 *   `data:` schemes (replaced with `#`). The raw safe URL is passed through
 *   un-escaped so module render() can call safeUrl() once — calling
 *   escapeHtml() here would double-escape ampersands in query strings.
 *
 * - Richtext props (`type: 'richtext'`):
 *   passed through sanitizeRichtext() (DOMPurify when a runtime is available,
 *   conservative tag stripping otherwise) as defense-in-depth on top of the
 *   editor-side sanitisation at write time.
 *
 * - Inline-SVG props (`type: 'svg'`):
 *   passed through sanitizeSvg() (DOMPurify SVG profile) so the `base.svg`
 *   module can emit raw `<svg>` markup.
 *
 * - Everything else, AND any prop with no matching schema entry:
 *   HTML-escaped via escapeHtml() — the safe default.
 *
 * Non-string values pass through unchanged so derived assets like
 * `_resolvedMediaByKey` (attached after this step) survive the boundary.
 */

import type { PropertyControl, PropertySchema } from '@core/module-engine'
import { escapeHtml, isSafeUrl } from './utils'
import { sanitizeRichtext, sanitizeSvg, sanitizePostBody } from '@core/sanitize'

/**
 * Resolve the control declared for `key`. Top-level keys are a direct lookup;
 * `group` controls hold their children under `.children` but DO NOT nest the
 * data shape (group is visual-only), so a child's key is still a flat prop key
 * — recurse one group level to find it.
 */
function controlForKey(schema: PropertySchema, key: string): PropertyControl | undefined {
  const direct = schema[key]
  if (direct) return direct
  for (const control of Object.values(schema)) {
    if (control.type === 'group') {
      const child = controlForKey(control.children, key)
      if (child) return child
    }
  }
  return undefined
}

/**
 * Escape every string prop before passing them to a module's render(),
 * dispatching per key on the prop's declared control `type`.
 *
 * - `type: 'url' | 'image' | 'media'` → isSafeUrl() (unsafe → '#'), no HTML
 *   escape (module's safeUrl() handles that)
 * - `type: 'richtext'` → sanitizeRichtext() (DOMPurify; text fallback)
 * - `type: 'svg'` → sanitizeSvg() (DOMPurify SVG profile)
 * - everything else, and any key absent from `schema` → escapeHtml()
 * - Non-string props → unchanged
 */
export function escapeProps(
  props: Record<string, unknown>,
  schema: PropertySchema,
): Record<string, unknown> {
  const escaped: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== 'string') {
      escaped[key] = value
      continue
    }

    const type = controlForKey(schema, key)?.type

    if (type === 'svg') {
      // Inline SVG: sanitise with the SVG DOMPurify profile (defense-in-depth
      // on top of the editor/importer write-time sanitisation). Passed through
      // raw — NOT escapeHtml'd — so the module emits real `<svg>` markup.
      escaped[key] = sanitizeSvg(value)
    } else if (type === 'richtext') {
      // Richtext: defense-in-depth sanitization via DOMPurify (Constraint #368).
      // DOMPurify runs at write time (editor/Properties Panel boundary); this is a
      // second pass at the publisher boundary so that corrupted or injected richtext
      // values cannot reach the published HTML unsanitized.
      // sanitizeRichtext falls back to conservative tag stripping only in
      // runtimes that have not installed DOMPurify (for example one-off scripts).
      escaped[key] = sanitizeRichtext(value)
    } else if (type === 'richtextBody') {
      // Post/page body content (base.outlet's markdown-rendered `html`):
      // wider allowlist than plain `richtext` (images, tables, iframe embeds
      // scoped to a trusted-host allowlist) — see POST_BODY_CONFIG in
      // @core/sanitize. Kept as its own control type rather than widening
      // RICHTEXT_CONFIG globally, so short-form richtext fields elsewhere in
      // the CMS stay on the narrower default.
      escaped[key] = sanitizePostBody(value)
    } else if (type === 'url' || type === 'image' || type === 'media') {
      // URLs: block javascript: and vbscript: schemes; pass safe URLs through raw
      // so that module render() functions can HTML-escape them via safeUrl() from
      // modules/base/utils/escape.ts.  Publisher HTML-escaping plain strings is the
      // escapeProps() contract for non-URL string props; URL props deliberately skip
      // the escapeHtml() step here to avoid double-escaping when modules call safeUrl()
      // (which also applies escapeHtml internally).
      // Note: publishPage() manually escapeHtml()'s faviconUrl because
      // those are not passed to module render() — they go directly into HTML template
      // strings that never pass through a module's safeUrl() call.
      escaped[key] = isSafeUrl(value) ? value : '#'
    } else {
      // Plain strings, and any prop with no matching schema entry: HTML-escape
      // (the safe default — a prop the schema doesn't describe is never trusted
      // to carry markup or a URL).
      escaped[key] = escapeHtml(value)
    }
  }

  return escaped
}
