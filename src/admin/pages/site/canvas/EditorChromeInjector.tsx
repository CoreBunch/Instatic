/**
 * EditorChromeInjector — injects a self-contained editor-chrome stylesheet
 * into each iframe <head> so editor-only elements (empty-state placeholders,
 * slot boundaries, the unknown-module fallback) are correctly styled inside
 * the iframe document where CSS Modules and parent-document tokens are absent.
 *
 * Why this is needed
 * ──────────────────
 * The canvas renders the page tree into an iframe via createPortal. CSS Module
 * rules (hashed class names like `.CanvasModulePlaceholder_root__abc123`) exist
 * only in the parent editor document's stylesheets — they are never present
 * inside the iframe document. Similarly, design tokens defined in globals.css
 * (--text-subtle, --canvas-placeholder-bg, etc.) only exist on the
 * parent document's :root.
 *
 * Two-part fix implemented here:
 *   1. Copy the tokens the chrome needs from the parent document's :root onto
 *      the iframe's :root at mount time, renamed into the `--chrome-*`
 *      namespace — so `var(--chrome-text-subtle)` etc. resolve inside the
 *      chrome CSS without shadowing the site's own custom properties.
 *   2. Style editor chrome via STABLE data-attribute selectors
 *      (data-canvas-module-placeholder, data-instatic-slot-instance, etc.) instead
 *      of hashed CSS-Module class names which will never match inside the iframe.
 *
 * Cascade isolation via @layer
 * ────────────────────────────
 * This style element is intentionally UNLAYERED. ClassStyleInjector and
 * UserStylesheetInjector both wrap their content in `@layer user-authored`,
 * making all author CSS lower-priority than any unlayered rule. The chrome CSS
 * wins over author rules without needing !important — user stylesheets cannot
 * bleed into placeholder / slot-boundary chrome even at high specificity.
 *
 * Mount order inside the portal:
 *   <EditorChromeInjector>   ← <style id="instatic-editor-chrome">  (unlayered)
 *   <ClassStyleInjector>     ← <style id="mc-classes">        (@layer user-authored)
 *   <UserStylesheetInjector> ← <style id="mc-user-styles">    (@layer user-authored)
 *   {children}
 *
 * Each iframe mounts its own instance of this component (and of the author
 * CSS injectors) — one IframeFrameSurface = one set of <style> elements.
 */

import { useEffect } from 'react'

const STYLE_TAG_ID = 'instatic-editor-chrome'

interface EditorChromeInjectorProps {
  /** The iframe document to inject the chrome stylesheet into. */
  targetDocument: Document
  /** The parent (editor) document to read design tokens from. */
  parentDocument: Document
}

/**
 * Editor-chrome CSS rules targeting stable data-* attributes.
 *
 * Every inheritable CSS property the chrome cares about (color, font-family,
 * font-size, font-weight, font-style, line-height, letter-spacing,
 * text-align, text-transform, white-space) is set EXPLICITLY on each chrome
 * element so nothing inherits from ancestor user elements. This is the second
 * isolation mechanism alongside the unlayered-vs-@layered cascade.
 *
 * Module-scope constant: stable across renders, not captured into closures.
 */
const CHROME_RULES = `
/* ── CanvasModulePlaceholder ───────────────────────────────────────────────
 * Reproduced from CanvasModulePlaceholder.module.css using stable
 * data-attribute selectors (data-canvas-module-placeholder, data-variant,
 * data-instatic-placeholder-*) added to the component alongside the existing
 * CSS-Module class names. The CSS-Module classes still style the component
 * when it renders outside the iframe (e.g. in tests); the data-attribute
 * hooks give the iframe chrome CSS a stable target.
 */

[data-canvas-module-placeholder] {
  display: block;
  box-sizing: border-box;
  min-width: 0;
  border-radius: var(--chrome-radius);
  background: var(--chrome-canvas-placeholder-bg);
  color: var(--chrome-text-subtle);
  font-size: var(--chrome-text-s);
  font-family: var(--chrome-font-sans);
  font-weight: 400;
  font-style: normal;
  line-height: 1.4;
  letter-spacing: normal;
  text-align: left;
  text-transform: none;
  white-space: normal;
  user-select: none;
}

[data-canvas-module-placeholder][data-variant="block"] {
  display: grid;
  place-items: center;
  width: 100%;
  min-height: 100px;
  padding: var(--chrome-space-xl);
  text-align: center;
}

[data-canvas-module-placeholder][data-variant="inline"] {
  display: inline-grid;
  align-items: center;
  min-height: 32px;
  padding: var(--chrome-space-xs) var(--chrome-space-m);
}

[data-canvas-module-placeholder] [data-instatic-placeholder-content] {
  box-sizing: border-box;
  min-width: 0;
  margin: 0;
  padding: 0;
  pointer-events: none;
}

[data-canvas-module-placeholder][data-variant="block"] [data-instatic-placeholder-content] {
  display: grid;
  justify-items: center;
  align-content: center;
  row-gap: var(--chrome-space-s);
}

[data-canvas-module-placeholder][data-variant="block"][data-layout="row"] [data-instatic-placeholder-content] {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: var(--chrome-space-s);
}

[data-canvas-module-placeholder][data-variant="inline"] [data-instatic-placeholder-content] {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--chrome-space-xs);
}

[data-canvas-module-placeholder] [data-instatic-placeholder-icon] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
  color: var(--chrome-text-disabled);
  font-size: inherit;
  font-weight: inherit;
  line-height: 1;
  letter-spacing: normal;
  text-transform: none;
  white-space: normal;
}

[data-canvas-module-placeholder] [data-instatic-placeholder-icon] > svg {
  display: block;
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
}

[data-canvas-module-placeholder] [data-instatic-placeholder-label] {
  display: block;
  margin: 0;
  padding: 0;
  color: var(--chrome-text-muted);
  font-size: var(--chrome-text-s);
  font-family: var(--chrome-font-sans);
  font-weight: 600;
  font-style: normal;
  line-height: 1.4;
  letter-spacing: normal;
  text-align: inherit;
  text-transform: none;
  white-space: normal;
}

[data-canvas-module-placeholder][data-variant="inline"] [data-instatic-placeholder-label] {
  font-weight: 500;
}

[data-canvas-module-placeholder] [data-instatic-placeholder-description] {
  max-width: 36ch;
  margin: 0;
  padding: 0;
  color: var(--chrome-text-subtle);
  font-size: var(--chrome-text-xs);
  font-family: var(--chrome-font-sans);
  font-weight: 500;
  font-style: normal;
  line-height: 1.4;
  letter-spacing: normal;
  text-align: inherit;
  text-transform: none;
  white-space: normal;
}

[data-canvas-module-placeholder] [data-instatic-placeholder-actions] {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--chrome-space-xs);
  margin-top: var(--chrome-space-3xs);
  pointer-events: auto;
}

[data-canvas-module-placeholder] [data-instatic-placeholder-actions] button {
  height: 28px;
  padding: 0 var(--chrome-space-xl);
  border: 1px solid color-mix(in srgb, var(--chrome-text) 14%, transparent);
  border-radius: 999px;
  background: var(--chrome-bg-surface);
  color: var(--chrome-text-bright);
  font-size: var(--chrome-text-xs);
  font-family: var(--chrome-font-sans);
  font-weight: 600;
  font-style: normal;
  letter-spacing: 0.01em;
  text-transform: none;
  cursor: default;
}

[data-canvas-module-placeholder] [data-instatic-placeholder-actions] button:hover {
  background: var(--chrome-bg-surface-2);
  border-color: color-mix(in srgb, var(--chrome-text) 22%, transparent);
}

[data-canvas-module-placeholder] [data-instatic-placeholder-actions] button:active {
  background: var(--chrome-bg-surface-3);
}

/* ── base.slot-instance ─────────────────────────────────────────────────────
 * Reproduced from SlotInstance.module.css using stable data-attribute selectors
 * (data-instatic-slot-instance, data-instatic-slot-instance-header, data-instatic-slot-label,
 * data-instatic-slot-instance-content) added to SlotInstanceEditor.tsx alongside
 * the existing CSS-Module class names.
 *
 * Uses the forwarded global border tokens so slot chrome matches the parent
 * editor document without duplicating literal values in this iframe stylesheet.
 */

[data-instatic-slot-instance] {
  border: 1px solid var(--chrome-border-muted);
  border-radius: var(--chrome-radius);
  background: var(--chrome-bg-surface);
  overflow: hidden;
  box-sizing: border-box;
  color: var(--chrome-text-subtle);
  font-size: var(--chrome-text-xs);
  font-family: var(--chrome-font-sans);
  font-weight: 400;
  font-style: normal;
  letter-spacing: normal;
  text-transform: none;
}

[data-instatic-slot-instance-header] {
  display: flex;
  align-items: center;
  gap: var(--chrome-space-2xs);
  padding: var(--chrome-space-4xs) var(--chrome-space-s);
  background: var(--chrome-bg-body);
  border-bottom: 1px dashed var(--chrome-border);
  color: var(--chrome-text-subtle);
  font-size: var(--chrome-text-xs);
  font-family: var(--chrome-font-sans);
  font-weight: 400;
  font-style: normal;
  line-height: 1.5;
  letter-spacing: normal;
  text-align: left;
  text-transform: none;
  white-space: normal;
  user-select: none;
  pointer-events: none;
}

[data-instatic-slot-instance-header] [data-instatic-slot-label] {
  color: var(--chrome-text-muted);
  font-size: var(--chrome-text-xs);
  font-style: italic;
  font-family: var(--chrome-font-sans);
  font-weight: 400;
  line-height: inherit;
  letter-spacing: normal;
  text-transform: none;
  white-space: normal;
}

[data-instatic-slot-instance-content] {
  min-height: 24px;
  padding: var(--chrome-space-3xs);
}

/* ── base.list placeholder ──────────────────────────────────────────────────
 * Reproduced from list.module.css .placeholder using the stable
 * data-instatic-list-placeholder attribute added to ListEditor.tsx.
 */

[data-instatic-list-placeholder] {
  color: var(--chrome-text-subtle);
  margin-bottom: var(--chrome-space-xs);
  font-family: var(--chrome-font-sans);
  font-weight: initial;
  font-style: initial;
  font-size: initial;
  letter-spacing: normal;
  text-transform: none;
}

/* ── NodeRenderer unknown-module fallback ───────────────────────────────────
 * Reproduced from NodeRenderer.module.css .unknownModule using the stable
 * data-instatic-unknown-module attribute added to NodeRenderer.tsx.
 */

[data-instatic-unknown-module] {
  outline: 1px dashed var(--chrome-danger);
  padding: var(--chrome-space-3xs);
  color: var(--chrome-text-subtle);
  font-family: var(--chrome-font-sans);
  font-size: var(--chrome-text-s);
  font-weight: 400;
  font-style: normal;
  letter-spacing: normal;
  text-transform: none;
  white-space: normal;
}
`.trim()

/**
 * Admin design tokens the chrome reads, forwarded from the parent document's
 * :root onto the iframe's :root at mount time. Copying at runtime keeps
 * globals.css as the single source of truth — no duplicated literal values.
 *
 * Every token is WRITTEN under the `--chrome-` namespace (`--radius` →
 * `--chrome-radius`, `--text-s` → `--chrome-text-s`), never under its admin
 * name. This stylesheet is unlayered and the site's CSS sits in
 * `@layer user-authored`, so a chrome declaration of `--radius`, `--text` or
 * `--space-s` on :root would beat the site's own token of the same name and
 * the canvas would render the site with editor values.
 *
 * Derived from the `var(--chrome-*)` references in CHROME_RULES, so the
 * forwarded set always matches what the rules read.
 */
const CHROME_TOKEN_PREFIX = '--chrome-'
const CHROME_TOKENS = [
  ...new Set(Array.from(CHROME_RULES.matchAll(/var\(--chrome-([\w-]+)\)/g), (match) => match[1])),
]

/**
 * Read each chrome token's admin value (`--<name>`) from parentDoc's computed
 * :root and return a `:root { ... }` block that sets it as `--chrome-<name>`
 * on the iframe's root. Only tokens that resolve to a non-empty value are
 * included.
 *
 * Module-scope so the React Compiler doesn't flag the getComputedStyle call
 * as a side-effect inside a component body.
 */
function buildTokenBlock(parentDoc: Document): string {
  const parentStyles = getComputedStyle(parentDoc.documentElement)
  const declarations = CHROME_TOKENS.flatMap((name) => {
    const value = parentStyles.getPropertyValue(`--${name}`).trim()
    return value ? [`  ${CHROME_TOKEN_PREFIX}${name}: ${value};`] : []
  })
  if (declarations.length === 0) return ''
  return `:root {\n${declarations.join('\n')}\n}`
}

export function EditorChromeInjector({ targetDocument, parentDocument }: EditorChromeInjectorProps) {
  useEffect(() => {
    let styleEl = targetDocument.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = targetDocument.createElement('style')
      styleEl.id = STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'EditorChromeInjector')
      // Prepend before author CSS injectors (ClassStyleInjector, UserStylesheetInjector)
      // so source order inside the head is tidy. The unlayered-vs-@layered cascade
      // is what actually ensures chrome wins — source order is secondary.
      targetDocument.head.insertBefore(styleEl, targetDocument.head.firstChild)
    }
    const tokenBlock = buildTokenBlock(parentDocument)
    styleEl.textContent = tokenBlock ? `${tokenBlock}\n\n${CHROME_RULES}` : CHROME_RULES
  }, [targetDocument, parentDocument])

  // Cleanup: remove the style element when the component unmounts or when
  // targetDocument changes. Captures the current doc value so cleanup always
  // targets the document this effect installed to.
  useEffect(() => {
    const targetDoc = targetDocument
    return () => {
      targetDoc.getElementById(STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument])

  return null
}
