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
 * (--editor-text-muted, --canvas-placeholder-bg, etc.) only exist on the
 * parent document's :root.
 *
 * Two-part fix implemented here:
 *   1. Copy the tokens the chrome needs from the parent document's :root onto
 *      the iframe's :root at mount time — so `var(--editor-text-muted)` etc.
 *      resolve correctly inside the chrome CSS.
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

/**
 * Design tokens to forward from the parent document's :root onto the iframe's
 * :root. These are exactly the tokens referenced in CHROME_RULES below.
 * Copying at runtime keeps globals.css as the single source of truth — no
 * duplicated literal values anywhere.
 */
const CHROME_TOKENS = [
  '--editor-radius',
  '--editor-radius-sm',
  '--editor-text-muted',
  '--editor-text-subtle',
  '--editor-text-secondary',
  '--editor-text',
  '--editor-text-bright',
  '--canvas-placeholder-bg',
  '--editor-surface',
  '--editor-surface-2',
  '--editor-surface-3',
  '--editor-bg',
  '--editor-border-med',
  '--editor-border',
  '--editor-danger',
] as const

/**
 * The editor's UI font, forwarded into the iframe for CHROME elements ONLY.
 *
 * Read from the parent's `--font-sans` but WRITTEN under a chrome-namespaced
 * variable. Setting `--font-sans` itself on the iframe `:root` (as this used
 * to) clobbers the SITE's `--font-sans` — the chrome injector is unlayered,
 * and unlayered always beats the site's font tokens in `@layer user-authored`,
 * so every canvas element silently rendered in the editor's font instead of
 * the site's configured one. CHROME_RULES reference `var(--editor-chrome-font-sans)`.
 */
const CHROME_FONT_SOURCE = '--font-sans'
const CHROME_FONT_TARGET = '--editor-chrome-font-sans'

interface EditorChromeInjectorProps {
  /** The iframe document to inject the chrome stylesheet into. */
  targetDocument: Document
  /** The parent (editor) document to read design tokens from. */
  parentDocument: Document
}

/**
 * Read the listed tokens from parentDoc's computed :root and return a
 * `:root { ... }` block that sets them on the iframe's root. Only tokens
 * that resolve to a non-empty value are included. The editor font is mapped
 * onto a chrome-namespaced variable so it never overrides the site's own
 * `--font-sans` (see CHROME_FONT_TARGET).
 *
 * Module-scope so the React Compiler doesn't flag the getComputedStyle call
 * as a side-effect inside a component body.
 */
function buildTokenBlock(parentDoc: Document): string {
  const parentStyles = getComputedStyle(parentDoc.documentElement)
  const declarations = CHROME_TOKENS.flatMap((token) => {
    const value = parentStyles.getPropertyValue(token).trim()
    return value ? [`  ${token}: ${value};`] : []
  })
  const chromeFont = parentStyles.getPropertyValue(CHROME_FONT_SOURCE).trim()
  if (chromeFont) declarations.push(`  ${CHROME_FONT_TARGET}: ${chromeFont};`)
  if (declarations.length === 0) return ''
  return `:root {\n${declarations.join('\n')}\n}`
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
  border-radius: var(--editor-radius);
  background: var(--canvas-placeholder-bg);
  color: var(--editor-text-muted);
  font-size: 12px;
  font-family: var(--editor-chrome-font-sans);
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
  padding: 14px;
  text-align: center;
}

[data-canvas-module-placeholder][data-variant="inline"] {
  display: inline-grid;
  align-items: center;
  min-height: 32px;
  padding: 6px 10px;
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
  row-gap: 8px;
}

[data-canvas-module-placeholder][data-variant="block"][data-layout="row"] [data-instatic-placeholder-content] {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

[data-canvas-module-placeholder][data-variant="inline"] [data-instatic-placeholder-content] {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

[data-canvas-module-placeholder] [data-instatic-placeholder-icon] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
  color: var(--editor-text-subtle);
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
  color: var(--editor-text-secondary);
  font-size: 12px;
  font-family: var(--editor-chrome-font-sans);
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
  color: var(--editor-text-muted);
  font-size: 11px;
  font-family: var(--editor-chrome-font-sans);
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
  gap: 6px;
  margin-top: 4px;
  pointer-events: auto;
}

[data-canvas-module-placeholder] [data-instatic-placeholder-actions] button {
  height: 28px;
  padding: 0 14px;
  border: 1px solid color-mix(in srgb, var(--editor-text) 14%, transparent);
  border-radius: 999px;
  background: var(--editor-surface);
  color: var(--editor-text-bright);
  font-size: 11px;
  font-family: var(--editor-chrome-font-sans);
  font-weight: 600;
  font-style: normal;
  letter-spacing: 0.01em;
  text-transform: none;
  cursor: default;
}

[data-canvas-module-placeholder] [data-instatic-placeholder-actions] button:hover {
  background: var(--editor-surface-2);
  border-color: color-mix(in srgb, var(--editor-text) 22%, transparent);
}

[data-canvas-module-placeholder] [data-instatic-placeholder-actions] button:active {
  background: var(--editor-surface-3);
}

/* ── base.slot-instance ─────────────────────────────────────────────────────
 * Reproduced from SlotInstance.module.css using stable data-attribute selectors
 * (data-instatic-slot-instance, data-instatic-slot-instance-header, data-instatic-slot-label,
 * data-instatic-slot-instance-content) added to SlotInstanceEditor.tsx alongside
 * the existing CSS-Module class names.
 *
 * Note: --editor-border-low is not defined in globals.css (it is only
 * referenced in SlotInstance.module.css). The chrome CSS falls back to
 * --editor-border which resolves to the nearest defined border token.
 */

[data-instatic-slot-instance] {
  border: 1px solid var(--editor-border-med);
  border-radius: var(--editor-radius);
  background: var(--editor-surface);
  overflow: hidden;
  box-sizing: border-box;
  color: var(--editor-text-muted);
  font-size: 11px;
  font-family: var(--editor-chrome-font-sans);
  font-weight: 400;
  font-style: normal;
  letter-spacing: normal;
  text-transform: none;
}

[data-instatic-slot-instance-header] {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  background: var(--editor-bg);
  border-bottom: 1px dashed var(--editor-border);
  color: var(--editor-text-muted);
  font-size: 11px;
  font-family: var(--editor-chrome-font-sans);
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
  color: var(--editor-text-secondary);
  font-size: 11px;
  font-style: italic;
  font-family: var(--editor-chrome-font-sans);
  font-weight: 400;
  line-height: inherit;
  letter-spacing: normal;
  text-transform: none;
  white-space: normal;
}

[data-instatic-slot-instance-content] {
  min-height: 24px;
  padding: 4px;
}

/* ── base.list placeholder ──────────────────────────────────────────────────
 * Reproduced from list.module.css .placeholder using the stable
 * data-instatic-list-placeholder attribute added to ListEditor.tsx.
 */

[data-instatic-list-placeholder] {
  color: var(--editor-text-muted);
  margin-bottom: 6px;
  font-family: var(--editor-chrome-font-sans);
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
  outline: 1px dashed var(--editor-danger);
  padding: 4px;
  color: var(--editor-text-muted);
  font-family: var(--editor-chrome-font-sans);
  font-size: 12px;
  font-weight: 400;
  font-style: normal;
  letter-spacing: normal;
  text-transform: none;
  white-space: normal;
}
`.trim()

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
