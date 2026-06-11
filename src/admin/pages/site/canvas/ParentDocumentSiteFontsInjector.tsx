/**
 * ParentDocumentSiteFontsInjector — makes the site's installed fonts
 * (`@font-face` only) available in the PARENT editor document.
 *
 * Why this exists
 * ───────────────
 * The canvas renders each breakpoint inside an iframe, and the site's font
 * `@font-face` rules are injected there by `ClassStyleInjector`. But overlays
 * that live in the PARENT document and sit visually on top of the canvas — the
 * inline text-edit field (`InlineTextEditOverlay`) — render in the parent's
 * font environment, which only has the admin UI font (Inter). When such an
 * overlay mirrors a node's computed `font-family` (e.g. "PP Right Grotesk"),
 * the parent has no matching `@font-face`, so the browser falls back to a
 * different typeface and the overlay reads as a different font than the
 * published text it covers.
 *
 * Injecting ONLY the `@font-face` rules (never the `--font-*` token variables,
 * which would re-point the admin chrome's own `--font-sans`) gives the parent
 * document the exact same font *resources* as the iframe. Custom and Google
 * fonts have unique family names, so they cannot collide with the admin UI.
 *
 * One instance, mounted at the canvas root.
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { generateSiteFontsCss } from '@core/fonts'

const STYLE_TAG_ID = 'instatic-parent-site-fonts'

export function ParentDocumentSiteFontsInjector() {
  const fonts = useEditorStore((s) => s.site?.settings.fonts ?? null)

  useEffect(() => {
    // `@font-face` only — `generateSiteFontsCss` never emits the `--font-*`
    // token variables, so the admin UI's own `--font-sans` is untouched.
    const css = generateSiteFontsCss(fonts)
    const head = document.head
    let styleEl = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null

    if (!css) {
      styleEl?.remove()
      return
    }
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = STYLE_TAG_ID
      head.appendChild(styleEl)
    }
    if (styleEl.textContent !== css) styleEl.textContent = css
  }, [fonts])

  // The stylesheet is global to the document; intentionally NOT removed on
  // unmount — the editor owns the parent document for its whole lifetime, and
  // leaving the faces cached avoids a reload flash when the canvas remounts.
  return null
}
