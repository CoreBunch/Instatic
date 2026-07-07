/**
 * useInstalledFontFaces — inject the site's installed `@font-face` rules into
 * the admin document head so panels can render text in the site's real fonts.
 *
 * The canvas iframe injects the same rules for its preview, but the admin
 * shell (where panels live) carries no `@font-face` declarations of its own —
 * without this, any `fontFamily` referencing an installed family silently
 * falls back to system-ui. The self-hosted `/uploads/fonts/...` `src` URLs
 * resolve through the dev proxy / published server exactly as on the canvas.
 *
 * Shared by the Typography panel's FontsSection and the Framework panel's
 * FrameworkHome — `dataSource` tags each caller's `<style>` element so the
 * two injections stay distinguishable in the inspector.
 */
import { useEffect } from 'react'
import type { FontEntry } from '@core/fonts'
import { generateSiteFontsCss } from '@core/fonts'

export function useInstalledFontFaces(fonts: readonly FontEntry[], dataSource: string): void {
  const css = generateSiteFontsCss({ items: [...fonts] })
  useEffect(() => {
    if (!css) return
    const styleEl = document.createElement('style')
    styleEl.setAttribute('data-source', dataSource)
    styleEl.textContent = css
    document.head.appendChild(styleEl)
    return () => {
      styleEl.remove()
    }
  }, [css, dataSource])
}
