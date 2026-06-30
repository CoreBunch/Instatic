/**
 * Publisher — framework CSS builder.
 *
 * Generates the platform-level CSS that lives in `framework.css` for a
 * published site:
 *   1. `@font-face` rules + `--font-<slug>` tokens (fonts library).
 *   2. Framework color / typography / spacing variables.
 *   3. Framework-generated utilities, tree-shaken by site preference.
 *
 * If the user hasn't configured any of those, this returns the empty string.
 * The publisher's external-mode emitter then skips the `framework.css` `<link>`
 * tag entirely so a brand-new project doesn't load a zero-byte stylesheet.
 *
 * The legacy `site.settings.colorTokens` raw `:root {}` path was removed —
 * the editor's Colors panel manages framework Color settings, which is the
 * single source of truth for color tokens. See SiteSettingsSchema for the
 * removal note.
 */

import type { SiteDocument } from '@core/page-tree'
import type { StyleRule } from '@core/page-tree'
import { buildFrameworkPlan } from '@core/framework'
import { resolveFrameworkPreferences } from '@core/framework'
import { collectUsedFrameworkClassIds } from '@core/framework'
import { generateFontsCss } from '@core/fonts'
import { generateClassCSS } from './classCss'

export function buildSiteFrameworkCss(site: SiteDocument): string {
  const { fonts } = site.settings
  // Fonts emit @font-face rules + --font-<slug> tokens. Emit first so any
  // rule that references a font family resolves against an already-declared
  // face. All `src` URLs are restricted to /uploads/fonts/ upstream — no CDN
  // linkage in the published page (Constraint: published HTML never reaches
  // Google).
  const fontsCss = generateFontsCss(fonts)
  const frameworkCss = generateFrameworkCss(site)
  return [fontsCss, frameworkCss]
    .filter(Boolean)
    .join('\n')
}

export function generateFrameworkCss(site: SiteDocument): string {
  const { rootCss, utilityClasses } = buildFrameworkPlan(site.settings.framework)
  return [rootCss, generateFrameworkUtilityCss(site, utilityClasses)]
    .filter(Boolean)
    .join('\n')
}

function generateFrameworkUtilityCss(
  site: SiteDocument,
  generatedClasses: Record<string, StyleRule>,
): string {
  const framework = site.settings.framework
  if (!framework) return ''

  const preferences = resolveFrameworkPreferences(framework.preferences)
  const classes = preferences.treeShakeGeneratedFrameworkUtilities
    ? pickUsedGeneratedClasses(generatedClasses, collectUsedFrameworkClassIds(site))
    : generatedClasses

  return generateClassCSS(classes, site.breakpoints, site.conditions ?? [])
}

function pickUsedGeneratedClasses(
  classes: Record<string, StyleRule>,
  usedClassIds: Set<string>,
): Record<string, StyleRule> {
  const picked: Record<string, StyleRule> = {}
  for (const classId of usedClassIds) {
    const cls = classes[classId]
    if (cls) picked[classId] = cls
  }
  return picked
}
