/**
 * substitutionEncode — make CSS declarations that use substitution functions
 * (`var()` / `env()`) survive ANY CSS engine's parse, byte-faithfully.
 *
 * ## The problem
 *
 * A declaration whose value contains `var()`/`env()` cannot be expanded at
 * parse time, and engines disagree about what their CSSOM then exposes:
 *
 * - **Chromium** stores a "pending-substitution value": `style.length`
 *   enumerates the shorthand's longhands, but `getPropertyValue(longhand)`
 *   returns `""` for every one. The authored text survives only in
 *   `style.cssText`.
 * - **happy-dom** (the test environment) is worse: it destroys the
 *   declaration at parse time — `border-left: 1px solid var(--rule)` becomes
 *   three longhands that EACH report the value `var(--rule)` (the `1px solid`
 *   part is gone), and `cssText` serialises the same mangle, so the authored
 *   declaration is unrecoverable from the CSSOM.
 *
 * Importing through either lossy view produced wrong or missing styles
 * (user-visibly: every `border: … var(--rule)` on an imported template).
 *
 * ## The fix — don't let engines see substitution declarations
 *
 * Every engine preserves CUSTOM PROPERTY declarations verbatim (validated in
 * Chromium and happy-dom: both enumerate them with byte-identical values).
 * So before parsing, each declaration whose value contains `var(`/`env(` is
 * rewritten to a marker custom property:
 *
 *   `border-left: 1px solid var(--rule)`
 *     → `--instatic-sub-border-left: 1px solid var(--rule)`
 *
 * and decoded back to its real property after the engine parse
 * (`decodeSubstitutionProperty`). The output is identical across engines BY
 * CONSTRUCTION — no per-engine recovery paths.
 *
 * `@keyframes` and `@font-face` blocks are left untouched: keyframes are
 * captured as raw CSS text (an encoded marker would leak into published
 * output), and font-face descriptors are read by the @font-face resolver.
 */

import { isEmittableProperty } from '@core/publisher'
/** Prefix for encoded substitution declarations. */
export const SUBSTITUTION_PROP_MARKER = '--instatic-sub-'

/** A value that contains a `var(` or `env(` substitution function. */
export const SUBSTITUTION_FN_RE = /\b(?:var|env)\(/

/** At-rule blocks whose contents must pass through unencoded. */
const SKIPPED_AT_RULES = new Set(['keyframes', 'font-face'])

/** A plain CSS property name (standard properties only — not `--custom`). */
const PLAIN_PROPERTY_RE = /^-?[a-zA-Z][a-zA-Z-]*$/

/**
 * Encode every substitution declaration in a full stylesheet. Everything else
 * is copied byte-for-byte (comments, whitespace, selectors, at-rules).
 */
export function encodeSubstitutionDeclarations(css: string): string {
  let out = ''
  let i = 0
  // One entry per open block: the at-rule name that opened it ('' for plain
  // selector blocks and unnamed at-rules).
  const blockStack: string[] = []
  const inSkippedBlock = () => blockStack.some((name) => SKIPPED_AT_RULES.has(name))

  while (i < css.length) {
    const ch = css[i]

    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      const stop = end === -1 ? css.length : end + 2
      out += css.slice(i, stop)
      i = stop
      continue
    }

    if (ch === '}') {
      blockStack.pop()
      out += ch
      i += 1
      continue
    }

    if (/\s/.test(ch)) {
      out += ch
      i += 1
      continue
    }

    if (ch === '@') {
      // At-rule prelude runs to `{` (block) or `;` (statement at-rule).
      const end = scanUntil(css, i, '{;')
      out += css.slice(i, end)
      if (end < css.length) {
        out += css[end]
        if (css[end] === '{') blockStack.push(atRuleName(css.slice(i, end)))
      }
      i = end + 1
      continue
    }

    // A chunk is either a selector (terminated by `{`) or a declaration
    // (terminated by `;` or the block's closing `}`).
    const end = scanUntil(css, i, '{;}')
    if (end >= css.length || css[end] === '{') {
      out += css.slice(i, end)
      if (end < css.length) {
        out += '{'
        blockStack.push('')
      }
      i = end + 1
      continue
    }

    out += inSkippedBlock() ? css.slice(i, end) : encodeDeclarationChunk(css.slice(i, end))
    if (css[end] === ';') {
      out += ';'
      i = end + 1
    } else {
      i = end // leave `}` for the loop to pop the block
    }
  }

  return out
}

/**
 * Encode a bare declaration list — the payload of a `style="…"` attribute.
 */
export function encodeSubstitutionDeclarationList(declarations: string): string {
  let out = ''
  let i = 0
  while (i < declarations.length) {
    const end = scanUntil(declarations, i, ';')
    out += encodeDeclarationChunk(declarations.slice(i, end))
    if (end < declarations.length) out += ';'
    i = end + 1
  }
  return out
}

/**
 * The real kebab-case property name behind an encoded declaration, or null
 * when `kebab` isn't a substitution marker.
 */
export function decodeSubstitutionProperty(kebab: string): string | null {
  return kebab.startsWith(SUBSTITUTION_PROP_MARKER)
    ? kebab.slice(SUBSTITUTION_PROP_MARKER.length)
    : null
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Rewrite one `prop: value` chunk to its marker form when the value uses a
 * substitution function. Custom properties and anything that doesn't parse as
 * a plain declaration pass through verbatim.
 */
function encodeDeclarationChunk(chunk: string): string {
  const colon = chunk.indexOf(':')
  if (colon === -1) return chunk
  const prop = chunk.slice(0, colon).trim()
  const value = chunk.slice(colon + 1)
  if (!PLAIN_PROPERTY_RE.test(prop) || !SUBSTITUTION_FN_RE.test(value)) return chunk
  const leading = chunk.slice(0, chunk.length - chunk.trimStart().length)
  return `${leading}${SUBSTITUTION_PROP_MARKER}${prop}:${value}`
}

/** Lower-cased at-rule name with any vendor prefix stripped (`@-webkit-keyframes` → `keyframes`). */
function atRuleName(prelude: string): string {
  const match = prelude.match(/^@(?:-[a-z]+-)?([a-zA-Z-]+)/i)
  return match ? match[1].toLowerCase() : ''
}

/**
 * Index of the first occurrence of any `stops` character at top level —
 * outside comments, strings, parens, and brackets. Returns `css.length` when
 * none is found.
 */
function scanUntil(css: string, start: number, stops: string): number {
  let depth = 0
  let quote: '"' | "'" | null = null
  let i = start
  while (i < css.length) {
    const ch = css[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      i += 1
      continue
    }
    if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    else if (depth === 0 && stops.includes(ch)) return i
    i += 1
  }
  return css.length
}

/**
 * Convert a kebab-case CSS property name to camelCase ("font-size" →
 * "fontSize"), the form the editor's style bags and the publisher both use.
 * CSS custom properties (`--brand`) are case-sensitive and must be stored
 * verbatim — camelCasing `--brand` into `-Brand` would change the property
 * and break the cascade — so they pass through unchanged. (Vendor-prefixed
 * names like `-webkit-foo` DO camelCase to `WebkitFoo`, matching the DOM
 * style API.)
 */
function kebabToCamel(prop: string): string {
  if (prop.startsWith('--')) return prop
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Walk a parsed `CSSStyleDeclaration` into a camelCase property bag:
 * decodes substitution markers back to their real property
 * (`decodeSubstitutionProperty`), converts kebab-case names to the camelCase
 * keys the editor stores, and drops security-denied property names
 * (`isEmittableProperty`). `onBlockedProperty` lets the caller surface a
 * warning per dropped declaration.
 *
 * This is the ONE CSSOM→bag walker — both the stylesheet importer
 * (`@core/siteImport` parseDeclarations) and the inline-style importer
 * (`@core/htmlImport` extractInlineStyles) build on it, so the substitution
 * decode and the security gate can never drift between the two paths.
 *
 * Uses `.length` + index access (not `for...of`) since CSSStyleDeclaration
 * does not enumerate properties via Symbol.iterator.
 */
export function readCssDeclarationBag(
  style: CSSStyleDeclaration,
  onBlockedProperty?: (camel: string, kebab: string) => void,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < style.length; i++) {
    const rawKebab = style[i]
    const value = style.getPropertyValue(rawKebab).trim()
    if (!value) continue
    const kebab = decodeSubstitutionProperty(rawKebab) ?? rawKebab
    const camel = kebabToCamel(kebab)
    if (!isEmittableProperty(camel)) {
      onBlockedProperty?.(camel, kebab)
      continue
    }
    out[camel] = value
  }
  return out
}
