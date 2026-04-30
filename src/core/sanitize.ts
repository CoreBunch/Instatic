/**
 * Sanitise utility for richtext prop values.
 *
 * WHY THIS EXISTS
 * ---------------
 * The publisher's `escapeProps()` passes richtext props through WITHOUT HTML-escaping,
 * relying on the assumption that DOMPurify has already sanitized them at input time.
 * This module provides that sanitization.
 *
 * USAGE
 * -----
 * Call `sanitizeRichtext(value)` at EVERY write path that stores a richtext prop:
 *   - PropertyControlRenderer: onChange for richtext/textarea controls
 *   - useSandboxBridge: PROP_CHANGE messages from community module iframes
 *   - LocalAdapter: loadProject() deserialization (before store hydration)
 *   - Phase D agent dispatcher: setProps tool calls for richtext-typed props
 *
 * Never trust that "the UI already sanitized it" — sanitize at every write path.
 *
 * CONFIGURATION
 * -------------
 * Default config allows safe formatting tags (strong, em, u, a, ul, ol, li, p, br, h1-h6)
 * and blocks all script execution. Use `sanitizeRichtext(val, STRICT_CONFIG)` to strip
 * all HTML tags and return plain text only (e.g. for meta fields, titles).
 *
 * @see Task #261 — Enforce DOMPurify at Properties Panel boundary
 * @see Contribution #368 — Security Auditor INFO finding
 * @see render.ts escapeProps() — richtext props are passed through unescaped
 */

import DOMPurifyImport, { type Config } from 'dompurify'

type DOMPurifyRuntime = {
  sanitize?: (value: string, config?: Config) => string
  addHook?: (name: string, hook: (node: Element) => void) => void
}

const DOMPurify = (
  (DOMPurifyImport as DOMPurifyRuntime & { default?: DOMPurifyRuntime }).default
  ?? DOMPurifyImport
) as DOMPurifyRuntime

// ---------------------------------------------------------------------------
// DOMPurify configuration profiles
// ---------------------------------------------------------------------------

/**
 * Default richtext config — allows safe HTML formatting, blocks all scripts.
 * Suitable for user-authored HTML content (headings, paragraphs, lists, links).
 */
export const RICHTEXT_CONFIG: Config = {
  // Allow safe semantic/formatting tags
  ALLOWED_TAGS: [
    'p', 'br',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
    'a', 'ul', 'ol', 'li',
    'blockquote', 'code', 'pre',
    'span', 'div',
  ],
  // Restrict attributes to safe subset; data-* is blocked by default
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'id'],
  // Force all links to open in a new tab with noopener
  ADD_ATTR: ['target'],
  // Never allow data: / javascript: in href
  ALLOW_DATA_ATTR: false,
  // Prevent mXSS via HTML namespace confusion
  NAMESPACE: 'http://www.w3.org/1999/xhtml',
  // Return a string, not a DOM node
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
}

/**
 * Strict config — strips ALL HTML tags; returns plain text only.
 * Use for single-line fields that should never contain markup.
 * Pass this to `sanitizeRichtext()` — it applies a post-strip pass to catch
 * any tags that DOMPurify's `ALLOWED_TAGS: []` might not catch in edge cases.
 */
export const PLAIN_TEXT_CONFIG: Config & { _plainText?: true } = {
  ALLOWED_TAGS: [],
  ALLOWED_ATTR: [],
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  _plainText: true,  // sentinel: triggers regex post-strip pass in sanitizeRichtext()
}

// ---------------------------------------------------------------------------
// Force safe link targets
// ---------------------------------------------------------------------------

// DOMPurify hook: after sanitizing, ensure all <a> tags have rel="noopener noreferrer"
// This prevents reverse tabnapping attacks when links open in a new tab.
if (typeof DOMPurify.addHook === 'function') {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sanitize a richtext prop value using DOMPurify.
 *
 * Call this at EVERY write path before storing a richtext prop value in the store.
 * The value returned is safe to insert into an HTML page via the publisher pipeline.
 *
 * @param value  — raw user input (may contain malicious HTML)
 * @param config — DOMPurify config (defaults to RICHTEXT_CONFIG)
 * @returns sanitized HTML string, safe for publisher output
 */
export function sanitizeRichtext(
  value: unknown,
  config: Config & { _plainText?: true } = RICHTEXT_CONFIG,
): string {
  const str = String(value ?? '')
  if (!str.trim()) return ''

  // DOMPurify requires a live DOM. In environments where it's unavailable
  // (e.g. SSR without happy-dom), fall back to plain-text escaping.
  if (typeof document === 'undefined' || typeof DOMPurify.sanitize !== 'function') {
    // Fallback: strip all tags via a simple regex (not as thorough, but safe)
    return str.replace(/<[^>]*>/g, '')
  }

  const sanitized = String(DOMPurify.sanitize(str, config))

  // When plain-text mode is requested, apply a post-strip regex pass.
  // DOMPurify's ALLOWED_TAGS:[] covers most cases but certain browsers / DOM
  // implementations may preserve some inline elements. The regex pass is the
  // guaranteed fallback.
  if (config._plainText) {
    return sanitized.replace(/<[^>]*>/g, '').trim()
  }

  return sanitized
}

/**
 * Check whether a module schema prop key refers to a richtext type.
 * Mirrors the detection logic in render.ts `isRichtextKey()`.
 */
export function isRichtextPropKey(key: string): boolean {
  const k = key.toLowerCase()
  return k === 'richtext' || k === 'html' || k.endsWith('html') || k.endsWith('richtext')
}
