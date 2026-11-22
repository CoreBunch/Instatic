/**
 * extractTheme — take a site's design variables, without its content, as a
 * portable `SiteTheme`. Same sources as `extractFragment` (a site-transfer
 * bundle or archive, or a live editor document).
 *
 *   - colours: every framework colour token, full definition;
 *   - fonts: every font token, and the library entries they bind to;
 *   - scales: every typography and spacing group;
 *   - custom properties: what the root-scope ambient rules declare, read
 *     through the same index fragments classify `var()`s with
 *     (`indexSiteVariables`);
 *   - media: custom font files, and any asset a custom property points at
 *     (`collectMedia`, as for a fragment), hashed and keyed for a package.
 *
 * Pure apart from reading media bytes through the source (and hashing them);
 * returns a theme that has passed `parseSiteTheme`.
 */

import type { FontToken } from '@core/fonts'
import { collectMedia } from './extractData'
import { indexSiteVariables } from './siteVariables'
import { SITE_THEME_FORMAT, SITE_THEME_VERSION, parseSiteTheme, type SiteTheme } from './themeSchema'
import type { FragmentSource } from './source'
import type { FragmentWarning } from './warnings'

export interface ExtractThemeOptions {
  origin?: SiteTheme['origin']
}

export interface ExtractThemeResult {
  theme: SiteTheme
  /** Bytes read while extracting, by theme media id — what `writeThemePackage` zips. */
  mediaBytes: Map<string, Uint8Array>
  warnings: FragmentWarning[]
}

export async function extractTheme(source: FragmentSource, options: ExtractThemeOptions = {}): Promise<ExtractThemeResult> {
  const { site } = source
  const warnings: FragmentWarning[] = []
  const framework = site.settings.framework

  const colors = [...(framework?.colors.tokens ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((token) => structuredClone(token))

  const families = site.settings.fonts?.items ?? []
  const familyIds = new Set(families.map((f) => f.id))
  const fontTokens = [...(site.settings.fonts?.tokens ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((token): FontToken => {
      if (!token.familyId || familyIds.has(token.familyId)) return structuredClone(token)
      warnings.push({
        code: 'missing-font-family',
        message: `The ${token.variable} token is bound to a font the library does not have; it travels as its fallback stack.`,
        subject: token.variable,
      })
      const { familyId: _missing, ...rest } = structuredClone(token)
      return rest
    })
  const boundFamilyIds = new Set(fontTokens.flatMap((t) => (t.familyId ? [t.familyId] : [])))
  const fontFamilies = families.filter((f) => boundFamilyIds.has(f.id)).map((f) => structuredClone(f))

  const customProperties = Object.fromEntries(indexSiteVariables(site).rootCustomProperties)

  const { media, mediaBytes } = await collectMedia(
    source,
    { styleRules: [], allNodes: [], tables: [], fontFamilies, customProperties },
    warnings,
  )

  const theme: SiteTheme = {
    format: SITE_THEME_FORMAT,
    version: SITE_THEME_VERSION,
    ...(options.origin ? { origin: options.origin } : {}),
    colors,
    fontTokens,
    fontFamilies,
    typography: (framework?.typography?.groups ?? []).map((group) => structuredClone(group)),
    spacing: (framework?.spacing?.groups ?? []).map((group) => structuredClone(group)),
    customProperties,
    media,
  }
  return { theme: parseSiteTheme(theme), mediaBytes, warnings }
}
