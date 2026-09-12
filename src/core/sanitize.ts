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
 *   - useSandboxBridge: PROP_CHANGE messages from sandboxed plugin module iframes
 *   - CMS draft hydration before store load
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

import DOMPurify, { type Config } from 'dompurify'

type DOMPurifyHookNode = {
  tagName?: string
  getAttribute?: (name: string) => string | null
  setAttribute?: (name: string, value: string) => void
  removeAttribute?: (name: string) => void
}

/**
 * A DOMPurify config plus the sentinels this module's own passes read.
 * DOMPurify hands the active config to every hook, so a policy that only one
 * profile wants (the image rules of `MARKDOWN_DOCUMENT_CONFIG`) travels with
 * that profile instead of applying to every sanitised document.
 */
export type SanitizerConfig = Config & {
  /** Regex post-strip pass in `sanitizeRichtext()`. */
  _plainText?: true
  /** Drop `<img src>` that is not absolute http(s) and stamp the rest no-referrer + lazy. */
  _externalImagesOnly?: true
}

export type DOMPurifyRuntime = {
  sanitize?: (value: string, config?: Config) => unknown
  addHook?: (
    hookName: 'afterSanitizeAttributes',
    callback: (node: DOMPurifyHookNode, hookEvent: null, config: SanitizerConfig) => void,
  ) => void
}

type DOMPurifyFactory = DOMPurifyRuntime & ((window: Window) => DOMPurifyRuntime)

const importedDOMPurify = DOMPurify as unknown as DOMPurifyFactory
let activeDOMPurify: DOMPurifyRuntime | null = null
const hookedPurifiers = new WeakSet<object>()

/**
 * Attribute post-pass, installed once per purifier: every link opens in a new
 * tab with `noopener`, and profiles that opt in (`_externalImagesOnly`) keep
 * only absolute http(s) images, stamped no-referrer + lazy. DOMPurify admits
 * `data:` on <img> regardless of `ALLOWED_URI_REGEXP`, so the image rule
 * cannot be expressed in the config alone.
 */
function installAttributeHook(purifier: DOMPurifyRuntime): DOMPurifyRuntime {
  if (!hookedPurifiers.has(purifier) && typeof purifier.addHook === 'function') {
    purifier.addHook('afterSanitizeAttributes', (node, _hookEvent, config) => {
      if (node.tagName === 'A') {
        node.setAttribute?.('target', '_blank')
        node.setAttribute?.('rel', 'noopener noreferrer')
      }
      if (node.tagName === 'IMG' && config._externalImagesOnly) {
        const src = node.getAttribute?.('src') ?? ''
        if (!/^https?:\/\//i.test(src.replace(/\s+/g, ''))) node.removeAttribute?.('src')
        node.setAttribute?.('referrerpolicy', 'no-referrer')
        node.setAttribute?.('loading', 'lazy')
      }
    })
    hookedPurifiers.add(purifier)
  }
  return purifier
}

export function configureRichtextSanitizer(purifier: DOMPurifyRuntime | null): void {
  activeDOMPurify = purifier ? installAttributeHook(purifier) : null
}

function getDOMPurify(): DOMPurifyRuntime | null {
  const direct = activeDOMPurify ?? importedDOMPurify
  if (typeof direct.sanitize === 'function') {
    return installAttributeHook(direct)
  }

  if (typeof window !== 'undefined' && typeof importedDOMPurify === 'function') {
    activeDOMPurify = importedDOMPurify(window)
    if (typeof activeDOMPurify.sanitize === 'function') {
      return installAttributeHook(activeDOMPurify)
    }
  }

  return null
}

/**
 * Regex HTML strip used ONLY when no DOMPurify runtime is available (one-off
 * scripts; browser + Bun server both configure DOMPurify).
 *
 * Three stages, each looped to a fixpoint with a single literal regex — the
 * exact do-while-until-stable form CodeQL recognises as a complete sanitizer
 * (js/incomplete-multi-character-sanitization). Looping matters because removing
 * one match can reveal another: split-tag obfuscation `<scr<script>ipt>` only
 * collapses after the inner match goes. Close tags use `(?:[\s/][^>]*)?` since
 * the HTML parser ends a tag at the first `>` (js/bad-tag-filter). Each pass
 * strictly shrinks the string, so every loop terminates.
 *
 * 1. drop `<script>…</script>` blocks (removes the JS source, not just the tag)
 * 2. drop `<style>…</style>` blocks (CSS can carry `@import url(javascript:…)`)
 * 3. drop every remaining tag, incl. bare/unbalanced `<script`/`<style` openers
 */
function stripHtmlFallback(value: string): string {
  let current = value
  let previous: string
  do {
    previous = current
    current = current.replace(/<script\b[^>]*>[\s\S]*?<\/script(?:[\s/][^>]*)?>/gi, '')
  } while (current !== previous)
  do {
    previous = current
    current = current.replace(/<style\b[^>]*>[\s\S]*?<\/style(?:[\s/][^>]*)?>/gi, '')
  } while (current !== previous)
  do {
    previous = current
    current = current.replace(/<[^>]*>/g, '')
  } while (current !== previous)
  return current
}

// ---------------------------------------------------------------------------
// DOMPurify configuration profiles
// ---------------------------------------------------------------------------

/**
 * Default richtext config — allows safe HTML formatting, blocks all scripts.
 * Suitable for user-authored HTML content (headings, paragraphs, lists, links).
 */
const RICHTEXT_CONFIG: Config = {
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
export const PLAIN_TEXT_CONFIG: SanitizerConfig = {
  ALLOWED_TAGS: [],
  ALLOWED_ATTR: [],
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  _plainText: true,  // sentinel: triggers regex post-strip pass in sanitizeRichtext()
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
  config: SanitizerConfig = RICHTEXT_CONFIG,
): string {
  const str = String(value ?? '')
  if (!str.trim()) return ''

  // DOMPurify requires a live DOM-backed runtime. The browser has one
  // naturally; the Bun server installs an explicit runtime in
  // `server/richtextSanitizer.ts`. One-off scripts that do neither get the
  // conservative plain-text fallback.
  const purifier = getDOMPurify()
  if (!purifier || typeof purifier.sanitize !== 'function') {
    const stripped = stripHtmlFallback(str)
    return config._plainText ? stripped.trim() : stripped
  }

  const sanitized = String(purifier.sanitize(str, config))

  // When plain-text mode is requested, apply a post-strip pass.
  // DOMPurify's ALLOWED_TAGS:[] covers most cases but certain browsers / DOM
  // implementations may preserve some inline elements. The fixpoint stripper is
  // the guaranteed fallback (and resists split-tag obfuscation).
  if (config._plainText) {
    return stripHtmlFallback(sanitized).trim()
  }

  return sanitized
}

/**
 * Check whether a module schema prop key refers to a richtext type.
 * Canonical key-name heuristic shared across layers (persistence validation,
 * the agent executor, and template binding resolution).
 */
export function isRichtextPropKey(key: string): boolean {
  const k = key.toLowerCase()
  return k === 'richtext' || k === 'html' || k.endsWith('html') || k.endsWith('richtext')
}

// ---------------------------------------------------------------------------
// SVG sanitisation
// ---------------------------------------------------------------------------

/**
 * SVG profile — allows the SVG + SVG-filter element/attribute set, blocks all
 * HTML (so `<foreignObject>` can't smuggle markup), scripts, and event
 * handlers. Used by the `base.svg` module so imported / pasted inline SVG
 * (logos, icons) round-trips and renders, while staying XSS-safe.
 *
 * `currentColor` and presentation attributes survive, so an SVG styled by a
 * CSS class (`fill: currentColor`) keeps inheriting the page's text colour.
 */
const SVG_CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  // Defence in depth: no HTML embedding (`foreignObject`), no script, no nested
  // anchors, and no `<style>` — DOMPurify keeps `<style>` in the svg profile but
  // does not strip `@import url(javascript:…)` from its CSS, and untrusted SVG
  // should carry no stylesheet of its own regardless. URI-bearing attributes
  // stay under DOMPurify's scheme validation so safe same-document references
  // such as <textPath href="#ring"> still resolve their SVG geometry.
  FORBID_TAGS: ['script', 'foreignObject', 'a', 'style'],
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
}

/**
 * Sanitise an inline-SVG markup string for safe inclusion in published HTML
 * and the editor canvas. Returns `''` when no DOMPurify runtime is available
 * (one-off scripts) — the browser and the Bun publish server both configure
 * one, so production paths always sanitise rather than drop.
 *
 * Call at every write path that stores an SVG prop (editor onChange, importer)
 * AND at the publisher boundary (`escapeProps`), per the "never trust the UI"
 * rule that governs richtext.
 */
export function sanitizeSvg(value: unknown): string {
  const str = String(value ?? '')
  if (!str.trim()) return ''

  const purifier = getDOMPurify()
  if (!purifier || typeof purifier.sanitize !== 'function') {
    // No runtime: refuse to emit unsanitised markup. Stripping tags would
    // empty the SVG anyway, so return nothing.
    return ''
  }

  return String(purifier.sanitize(str, SVG_CONFIG))
}

/**
 * Markdown-document config — the richtext set plus the elements GFM READMEs
 * rely on: images (badges, logos), tables, rules, collapsible `<details>`.
 * Used by the Dependencies panel to render package READMEs the publisher's
 * markdown renderer produced. No form controls (a README must not put a live
 * password or file input inside the admin), no `data:` or relative URLs, and
 * every image is stamped `referrerpolicy="no-referrer"` by the attribute
 * hook (`_externalImagesOnly`) so a README badge never learns which CMS
 * origin viewed it.
 *
 * `ALLOWED_URI_REGEXP` is matched against every attribute value that is not
 * URI-safe, so the non-URI attributes this profile adds (`width="120"`,
 * `align="center"`) must be declared URI-safe or DOMPurify drops them.
 */
export const MARKDOWN_DOCUMENT_CONFIG: SanitizerConfig = {
  ...RICHTEXT_CONFIG,
  ALLOWED_TAGS: [
    ...(RICHTEXT_CONFIG.ALLOWED_TAGS ?? []),
    'hr', 'sup', 'sub', 'kbd',
    'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'details', 'summary',
  ],
  // `id` and `class` are deliberately dropped from the richtext set: a README
  // is third-party markup rendered inside the admin, and an attacker-chosen
  // `id` collides with the app's own elements (`#tooltip-root` would capture
  // every tooltip portal). README anchors only need `href="#…"`, which works
  // without ids on the target.
  ALLOWED_ATTR: [
    ...(RICHTEXT_CONFIG.ALLOWED_ATTR ?? []).filter((attr) => attr !== 'id' && attr !== 'class'),
    'src', 'alt', 'title', 'width', 'height', 'align', 'loading', 'referrerpolicy', 'open',
  ],
  ADD_URI_SAFE_ATTR: ['width', 'height', 'align', 'loading', 'referrerpolicy', 'open'],
  ALLOWED_URI_REGEXP: /^(?:https?:\/\/|#)/i,
  _externalImagesOnly: true,
}
