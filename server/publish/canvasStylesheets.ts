/**
 * Canvas plugin stylesheets — the stylesheets plugins add to published pages,
 * resolved to CSS text for the site editor's canvas.
 *
 * A page styled by a plugin stylesheet must look the same while editing as it
 * does once published. The canvas is a set of `srcDoc` iframes the editor
 * fills itself, so the tags `injectFrontendAssets` splices into published
 * HTML never reach it. This module produces the canvas's share of the same
 * plan:
 *
 *   - Same plugins: `listFrontendAssetPlugins` (enabled, not errored, GRANTED
 *     `frontend.assets`) is the single eligibility rule the publisher uses.
 *   - Same order: placement anchor in document order, then plugin id, then
 *     manifest declaration order.
 *   - Styles ONLY: `style` and `style-inline`. `script`, `script-inline`,
 *     `link` and `meta` are deliberately left out. The canvas shares the admin
 *     origin, so a plugin frontend script running there would run with the
 *     editor's session; and trackers/widgets must not fire on an editing
 *     surface. The canvas shows how a page looks, not what its scripts do.
 *
 * External stylesheets are read from the plugin's upload directory and
 * returned as text rather than as a URL: the canvas has to pin viewport units
 * to the frame viewport (see `@core/utils/viewportUnits`) and wrap author CSS
 * in a cascade layer, and neither is possible on a `<link>`. Because the text
 * then lives in a `<style>` element (where relative URLs resolve against the
 * document, not the stylesheet), relative `url(...)` / `@import` references
 * are rebased onto the stylesheet's own URL here.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DbClient } from '../db/client'
import type { CanvasPluginStylesheet } from '@core/plugins/canvasStylesheets'
import { assertPathWithin } from '../util/pathWithin'
import {
  FRONTEND_PLACEMENT_ORDER,
  frontendAssetPlacement,
  listFrontendAssetPlugins,
  resolveFrontendAssetUrl,
} from './frontendInjections'

export async function collectCanvasPluginStylesheets(
  db: DbClient,
  uploadsDir: string | undefined,
): Promise<CanvasPluginStylesheet[]> {
  const plugins = await listFrontendAssetPlugins(db)
  const stylesheets: CanvasPluginStylesheet[] = []

  for (const placement of FRONTEND_PLACEMENT_ORDER) {
    const position = placement === 'head' ? 'before-site' : 'after-site'
    for (const plugin of plugins) {
      for (const asset of plugin.manifest.frontend?.assets ?? []) {
        // Scripts, bare links and meta tags never reach the canvas.
        if (asset.kind !== 'style' && asset.kind !== 'style-inline') continue
        if (frontendAssetPlacement(asset) !== placement) continue

        const media = asset.attrs?.media
        const base = { pluginId: plugin.manifest.id, position, ...(media ? { media } : {}) } as const

        if (asset.kind === 'style-inline') {
          stylesheets.push({ ...base, css: asset.content })
          continue
        }

        const url = resolveFrontendAssetUrl(plugin, asset.href)
        if (!url || !uploadsDir) continue
        const css = await readStylesheet(uploadsDir, url, plugin.manifest.id)
        if (css !== null) stylesheets.push({ ...base, css: rebaseCssUrls(css, url) })
      }
    }
  }

  return stylesheets
}

/**
 * Read a plugin stylesheet from disk. A missing or unreadable file skips that
 * one stylesheet (the published page would 404 the same `<link>`) instead of
 * failing the whole canvas plan.
 */
async function readStylesheet(uploadsDir: string, url: string, pluginId: string): Promise<string | null> {
  const fullPath = join(uploadsDir, url.replace(/^\/uploads\/?/, ''))
  try {
    assertPathWithin(uploadsDir, fullPath)
    return await readFile(fullPath, 'utf-8')
  } catch (err) {
    console.warn(`[plugin:${pluginId}] canvas stylesheet ${url} could not be read:`, err)
    return null
  }
}

// Single-pass scanner. Comments and ordinary strings are consumed first and
// passed through verbatim so a `url(` inside them is never rewritten; the
// remaining branches capture an `@import "<ref>"` string and a `url(<ref>)`
// token (double-quoted, single-quoted, or bare).
const CSS_REFERENCE_SCAN =
  /\/\*[\s\S]*?\*\/|(@import\s+)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|((?:[^)\\\s"']|\\.)*))\s*\)/gi

/** Absolute paths, fragments, and anything with a scheme are left alone. */
const NON_RELATIVE_REFERENCE = /^(?:\/|#|[a-z][a-z0-9+.-]*:)/i

/**
 * Rebase the relative references in a stylesheet onto `stylesheetUrl` (a
 * root-relative path such as `/uploads/plugins/<id>/<version>/frontend/x.css`).
 */
export function rebaseCssUrls(css: string, stylesheetUrl: string): string {
  const rebase = (reference: string): string => {
    const trimmed = reference.trim()
    if (!trimmed || NON_RELATIVE_REFERENCE.test(trimmed)) return reference
    const resolved = new URL(trimmed, `http://plugin.invalid${stylesheetUrl}`)
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  }

  return css.replace(
    CSS_REFERENCE_SCAN,
    (match, importPrefix, importDouble, importSingle, urlDouble, urlSingle, urlBare) => {
      if (importPrefix !== undefined) {
        return `${importPrefix}"${rebase(importDouble ?? importSingle ?? '')}"`
      }
      const reference = urlDouble ?? urlSingle ?? urlBare
      if (reference === undefined) return match
      return `url("${rebase(reference)}")`
    },
  )
}
