/**
 * UserStylesheetInjector — injects user-authored CSS files (from
 * `site.files[type === 'style']`) into a target document.
 *
 * Multi-document support
 * ──────────────────────
 * Each breakpoint frame in the canvas is its own iframe. `IframeFrameSurface`
 * mounts one of these injectors per frame, targeting the iframe's document
 * so user CSS lands inside the page document — exactly where it sits on the
 * published site. When no `targetDocument` prop is passed, the injector
 * falls back to the editor's main document (currently only used by tests
 * and any non-iframe canvas path).
 *
 * The CSS goes in unchanged. Inside the iframe the `<body>` IS the page
 * body, `body > nav` is a real direct-child relationship, and `:nth-child()`
 * counts the authored elements — no rewriting needed. This is the whole
 * point of the iframe-per-frame architecture (see
 * `docs/features/canvas-iframe-per-frame.md`).
 *
 * The injected CSS is produced by `collectUserStylesheetCss` (the same helper
 * the publisher uses) scoped to the active page, so each iframe loads the
 * exact bytes the published page receives — same stylesheet selection (scope
 * + enable state), same cascade order (priority, then path), same comment
 * wrapping.
 */

import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { collectUserStylesheetCss } from '@core/publisher'
import { resolveViewportUnits, type Viewport } from '@core/utils/viewportUnits'

const STYLE_TAG_ID = 'mc-user-styles'

interface UserStylesheetInjectorProps {
  /**
   * Document to inject the <style> tag into. Defaults to the editor's main
   * document.
   */
  targetDocument?: Document
  /**
   * Frame viewport used to resolve CSS viewport units (`vh`/`vw`/…) to fixed
   * px so they don't feed the iframe's grow-to-content height loop. When
   * omitted (non-iframe contexts), CSS is injected verbatim. See
   * `@core/utils/viewportUnits`.
   */
  viewport?: Viewport
}

export function UserStylesheetInjector({ targetDocument, viewport }: UserStylesheetInjectorProps = {}) {
  const site = useEditorStore((s) => s.site)
  const activePageId = useEditorStore((s) => s.activePageId)

  // Concatenate the user stylesheets that target the active page, in cascade
  // order. Delegates to `collectUserStylesheetCss` so the canvas loads the
  // exact bytes the published page receives — scope, priority, and enable
  // state all honoured. Viewport units are then pinned to the frame viewport
  // (canvas-only) so authored `vh`/`vmax`/… can't make the grow-to-content
  // iframe height explode.
  const activePage = site ? site.pages.find((page) => page.id === activePageId) ?? site.pages[0] : undefined
  const collected = site && activePage ? collectUserStylesheetCss(site, activePage) : ''
  const css = viewport ? resolveViewportUnits(collected, viewport) : collected

  useEffect(() => {
    const targetDoc = targetDocument ?? document
    let styleEl = targetDoc.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = targetDoc.createElement('style')
      styleEl.id = STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'UserStylesheetInjector')
      targetDoc.head.appendChild(styleEl)
    }
    // Wrap in a named cascade layer so editor-chrome CSS (unlayered, from
    // EditorChromeInjector) always wins over user-authored stylesheets regardless
    // of specificity. User styles still cascade among themselves normally inside
    // the layer (source order + specificity preserved).
    styleEl.textContent = css
      ? `@layer user-authored {\n${css}\n}`
      : '/* no user stylesheets */'
  }, [targetDocument, css])

  useEffect(() => {
    const targetDoc = targetDocument ?? document
    return () => {
      targetDoc.getElementById(STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument])

  return null
}
