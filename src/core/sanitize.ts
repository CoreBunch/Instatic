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
  remove?: () => void
}

type DOMPurifySanitizeElementData = { tagName: string; allowedTags: Record<string, boolean> }

export type DOMPurifyRuntime = {
  sanitize?: (value: string, config?: Config) => unknown
  addHook?: {
    (hookName: 'afterSanitizeAttributes', callback: (node: DOMPurifyHookNode) => void): void
    (
      hookName: 'uponSanitizeElement',
      callback: (node: DOMPurifyHookNode, data: DOMPurifySanitizeElementData) => void,
    ): void
  }
}

type DOMPurifyFactory = DOMPurifyRuntime & ((window: Window) => DOMPurifyRuntime)

const importedDOMPurify = DOMPurify as unknown as DOMPurifyFactory
let activeDOMPurify: DOMPurifyRuntime | null = null
const purifiersWithLinkHook = new WeakSet<object>()

function installLinkHook(purifier: DOMPurifyRuntime): DOMPurifyRuntime {
  if (!purifiersWithLinkHook.has(purifier) && typeof purifier.addHook === 'function') {
    purifier.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute?.('target', '_blank')
        node.setAttribute?.('rel', 'noopener noreferrer')
      }
    })
    purifiersWithLinkHook.add(purifier)
  }
  return purifier
}

export function configureRichtextSanitizer(purifier: DOMPurifyRuntime | null): void {
  activeDOMPurify = purifier ? installLinkHook(purifier) : null
}

function getDOMPurify(): DOMPurifyRuntime | null {
  const direct = activeDOMPurify ?? importedDOMPurify
  if (typeof direct.sanitize === 'function') {
    return installLinkHook(direct)
  }

  if (typeof window !== 'undefined' && typeof importedDOMPurify === 'function') {
    activeDOMPurify = importedDOMPurify(window)
    if (typeof activeDOMPurify.sanitize === 'function') {
      return installLinkHook(activeDOMPurify)
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
 * Hosts a `<iframe>` in post-body content is allowed to embed. Checked
 * against the `src` attribute's hostname (case-insensitive, exact match or
 * subdomain of one of these) by the DOMPurify hook installed below —
 * everything else has its iframe stripped, script tags and all other
 * dangerous elements are already excluded by ALLOWED_TAGS regardless of
 * this list.
 */
const TRUSTED_IFRAME_HOSTS = [
  'youtube.com',
  'youtube-nocookie.com',
] as const

function isTrustedIframeHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return TRUSTED_IFRAME_HOSTS.some((trusted) => host === trusted || host.endsWith(`.${trusted}`))
}

/**
 * Post-body config — used for full post/page body content rendered from
 * markdown (base.outlet's `html` binding, `richtextBody` control type).
 * Wider than `RICHTEXT_CONFIG`: adds the block-level elements a markdown
 * body actually produces (images, GFM tables, headings' remaining levels,
 * horizontal rules, the CMS `@[video](url)` embed) PLUS `iframe`, scoped to
 * `TRUSTED_IFRAME_HOSTS` via the `uponSanitizeElement` hook below — an
 * iframe whose `src` host isn't on the allowlist (or is missing/unparsable)
 * is removed entirely, not just stripped of the offending attribute, since
 * a same-tag-different-src replacement is exactly what an attacker would
 * try first.
 *
 * `source`, `figure`, and `figcaption` are included because that's the
 * markup real rich-text editors and importers (Webflow, etc.) actually
 * emit — a `<video>` wraps its playable file in `<source src=… type=…>`
 * rather than using `<video src=…>` directly, and images get wrapped in
 * `<figure>`/`<figcaption>` for captions. Without `source` the tag was
 * previously dropped, so a `<video controls poster="…"><source src="…"
 * type="video/mp4"></video>` published as a bare, unplayable `<video
 * controls>`.
 */
const POST_BODY_CONFIG: Config = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
    'a', 'ul', 'ol', 'li',
    'blockquote', 'code', 'pre',
    'span', 'div',
    'img', 'video', 'source', 'figure', 'figcaption',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'iframe',
  ],
  ALLOWED_ATTR: [
    'href', 'target', 'rel', 'class', 'id',
    'src', 'alt', 'title', 'loading', 'controls',
    'width', 'height', 'frameborder', 'allow', 'allowfullscreen', 'referrerpolicy',
    'poster', 'type', 'playsinline', 'loop', 'muted', 'preload',
  ],
  ADD_ATTR: ['target'],
  ALLOW_DATA_ATTR: false,
  NAMESPACE: 'http://www.w3.org/1999/xhtml',
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
}

const postBodyPurifiersWithIframeHook = new WeakSet<object>()

function installIframeHostHook(purifier: DOMPurifyRuntime): DOMPurifyRuntime {
  if (postBodyPurifiersWithIframeHook.has(purifier) || typeof purifier.addHook !== 'function') {
    return purifier
  }
  purifier.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName !== 'iframe') return
    const src = node.getAttribute?.('src') ?? ''
    let hostname: string
    try {
      hostname = new URL(src, 'http://invalid.example').hostname
    } catch {
      hostname = ''
    }
    if (!src || !isTrustedIframeHost(hostname)) {
      node.remove?.()
    }
  })
  postBodyPurifiersWithIframeHook.add(purifier)
  return purifier
}

/**
 * Sanitize full post/page body HTML (already markdown-rendered) — the
 * `richtextBody` control type's escapeProps() path. See `POST_BODY_CONFIG`.
 */
export function sanitizePostBody(value: unknown): string {
  const str = String(value ?? '')
  if (!str.trim()) return ''

  const purifier = getDOMPurify()
  if (!purifier || typeof purifier.sanitize !== 'function') {
    return stripHtmlFallback(str)
  }

  installIframeHostHook(purifier)
  return String(purifier.sanitize(str, POST_BODY_CONFIG))
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
  // Defence in depth — DOMPurify's svg profile already excludes these, but be
  // explicit: no HTML embedding, no script, and no nested anchors. URI-bearing
  // attributes stay under DOMPurify's scheme validation so safe same-document
  // references such as <textPath href="#ring"> can resolve their SVG geometry.
  FORBID_TAGS: ['script', 'foreignObject', 'a'],
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
