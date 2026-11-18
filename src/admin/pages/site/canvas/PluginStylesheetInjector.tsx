/**
 * PluginStylesheetInjector — injects the stylesheets that plugins add to
 * published pages (`frontend.assets[]` of kind `style` / `style-inline`) into
 * a canvas frame's document, so a page styled by a plugin looks the same
 * while editing as it does once published.
 *
 * Styles only. A plugin's frontend scripts, bare `<link>` and `<meta>` tags
 * are never loaded here: the canvas shares the admin origin, and trackers or
 * widgets must not run on an editing surface. The server filters them out
 * (`server/publish/canvasStylesheets.ts`); this component only ever creates
 * `<style>` elements.
 *
 * Cascade parity with the published page
 * ──────────────────────────────────────
 * On a published page plugin CSS and site CSS are ordinary, unlayered
 * stylesheets that differ only by document order. The canvas wraps the site's
 * CSS in `@layer user-authored` (so unlayered editor chrome always wins), so
 * plugin CSS goes into the SAME layer to keep that relationship: a
 * `before-site` sheet (`head` placement) is inserted ahead of the site's
 * style tags, an `after-site` sheet (every other placement) after them.
 * Mount this injector after `ClassStyleInjector` and `UserStylesheetInjector`.
 *
 * Like the other author-CSS injectors, viewport units are pinned to the frame
 * viewport so a plugin's `min-height: 100vh` cannot feed the grow-to-content
 * iframe height loop. One known difference from a published page: an
 * `@import` inside a plugin stylesheet is not followed, because CSS does not
 * allow `@import` inside a layer block.
 */

import { useEffect } from 'react'
import { resolveViewportUnits, type Viewport } from '@core/utils/viewportUnits'
import { useCanvasPluginStylesheets } from './canvasPluginStylesheets'

const STYLE_SOURCE = 'PluginStylesheetInjector'
const STYLE_SELECTOR = `style[data-source="${STYLE_SOURCE}"]`

interface PluginStylesheetInjectorProps {
  /** The canvas frame's document. */
  targetDocument: Document
  /** Frame viewport used to resolve CSS viewport units to fixed px. */
  viewport?: Viewport
}

export function PluginStylesheetInjector({ targetDocument, viewport }: PluginStylesheetInjectorProps) {
  const stylesheets = useCanvasPluginStylesheets()
  // The effect keys on the viewport's numbers, not the object: callers build
  // `viewport` inline, and a new-but-equal object must not tear down and
  // re-add every plugin <style> tag.
  const viewportWidth = viewport?.width
  const viewportHeight = viewport?.height

  useEffect(() => {
    const head = targetDocument.head
    // `before-site` sheets go ahead of everything the other injectors put in
    // <head>; the anchor is captured once so their relative order is kept.
    const siteStylesStart = head.firstChild

    for (const stylesheet of stylesheets) {
      const css =
        viewportWidth !== undefined && viewportHeight !== undefined
          ? resolveViewportUnits(stylesheet.css, { width: viewportWidth, height: viewportHeight })
          : stylesheet.css
      const styleEl = targetDocument.createElement('style')
      styleEl.setAttribute('data-source', STYLE_SOURCE)
      styleEl.setAttribute('data-plugin-id', stylesheet.pluginId)
      if (stylesheet.media) styleEl.media = stylesheet.media
      styleEl.textContent = `@layer user-authored {\n${css}\n}`
      if (stylesheet.position === 'before-site') head.insertBefore(styleEl, siteStylesStart)
      else head.appendChild(styleEl)
    }

    return () => {
      for (const styleEl of targetDocument.querySelectorAll(STYLE_SELECTOR)) styleEl.remove()
    }
  }, [targetDocument, stylesheets, viewportWidth, viewportHeight])

  return null
}
