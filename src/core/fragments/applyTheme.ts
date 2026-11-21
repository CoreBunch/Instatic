/**
 * Theme resolve + apply.
 *
 * `resolveThemePlan` swaps the theme's placeholders for what the server work
 * produced: media paths in custom property values for the uploaded URLs,
 * to-be-installed font families for the installed entries. Pure.
 *
 * `applyResolvedTheme` writes a resolved theme into a site document. Mutates
 * `site` in place, so the editor runs it inside ONE Mutative recipe and the
 * whole theme is one undo step. Colours, font tokens and scale groups are
 * matched again by slug, variable and convention here, so a token the site
 * gained after planning is overwritten rather than duplicated. Framework
 * utility classes are NOT regenerated here: when `frameworkChanged` is true
 * the caller regenerates them in the same transaction (as for fragments).
 */

import type { FontEntry } from '@core/fonts'
import { normalizeFontTokenVariable } from '@core/fonts'
import type { SiteDocument } from '@core/page-tree'
import { normalizeFrameworkColorSlug } from '@core/framework'
import type { FrameworkSpacingGroup, FrameworkTypographyGroup } from '@core/framework-schema'
import { writeRootProperties } from './apply'
import { createPathReplacer } from './references'
import { copyScaleSizing, themeColorDefinition, type PlannedThemeFontToken, type ThemeApplyPlan } from './planTheme'

/** The plan with every reference resolved; what the store transaction applies. */
export type ResolvedThemePlan = Omit<ThemeApplyPlan, 'fontFamilies' | 'media'> & {
  /** Font library entries installed or registered for this theme. */
  fontEntries: FontEntry[]
}

export interface ThemeResolution {
  /** Theme media path → uploaded (or reused) URL. */
  mediaUrlByPath: ReadonlyMap<string, string>
  /** Theme font family id → installed entry. Failed installs are absent. */
  fontEntryByFamilyId: ReadonlyMap<string, FontEntry>
}

export function resolveThemePlan(plan: ThemeApplyPlan, resolution: ThemeResolution): ResolvedThemePlan {
  const replacePaths = createPathReplacer(resolution.mediaUrlByPath)
  const fontTokens = plan.fontTokens.flatMap((planned): PlannedThemeFontToken[] => {
    if (!planned.installFamilyId) return [planned]
    const installed = resolution.fontEntryByFamilyId.get(planned.installFamilyId)
    if (installed) return [{ action: planned.action, token: { ...planned.token, familyId: installed.id } }]
    // The family did not install: a rebound token keeps its current family,
    // an added one falls back to its stack.
    return planned.action === 'rebind' ? [] : [{ action: planned.action, token: planned.token }]
  })
  const customProperties = plan.customProperties.map((planned) => ({
    ...planned,
    properties: Object.fromEntries(Object.entries(planned.properties).map(([name, value]) => [name, replacePaths(value)])),
  }))
  const { fontFamilies: _fontFamilies, media: _media, ...rest } = plan
  return { ...rest, fontTokens, customProperties, fontEntries: [...resolution.fontEntryByFamilyId.values()] }
}

export function applyResolvedTheme(site: SiteDocument, plan: ResolvedThemePlan): { frameworkChanged: boolean } {
  const now = Date.now()
  const { typography, spacing } = plan.scaleGroups
  const frameworkChanged = plan.colors.length > 0 || typography.length > 0 || spacing.length > 0

  // ── Colours and scale groups ───────────────────────────────────────────────
  if (frameworkChanged) {
    site.settings.framework ??= { colors: { tokens: [] } }
    const framework = site.settings.framework
    const tokens = framework.colors.tokens
    for (const token of plan.colors) {
      const existing = tokens.find((t) => normalizeFrameworkColorSlug(t.slug) === token.slug)
      if (existing) Object.assign(existing, structuredClone(themeColorDefinition(token)), { updatedAt: now })
      else tokens.push(token)
    }
    if (typography.length > 0) {
      framework.typography ??= { groups: [] }
      upsertScaleGroups(framework.typography.groups, typography.map((p) => p.group), now)
    }
    if (spacing.length > 0) {
      framework.spacing ??= { groups: [] }
      upsertScaleGroups(framework.spacing.groups, spacing.map((p) => p.group), now)
    }
  }

  // ── Fonts ──────────────────────────────────────────────────────────────────
  if (plan.fontEntries.length > 0 || plan.fontTokens.length > 0) {
    site.settings.fonts ??= { items: [] }
    const fonts = site.settings.fonts
    for (const entry of plan.fontEntries) {
      if (!fonts.items.some((f) => f.id === entry.id)) fonts.items.push(entry)
    }
    if (plan.fontTokens.length > 0) {
      fonts.tokens ??= []
      for (const { token } of plan.fontTokens) {
        const variable = normalizeFontTokenVariable(token.variable)
        const existing = fonts.tokens.find((t) => normalizeFontTokenVariable(t.variable) === variable)
        if (!existing) {
          fonts.tokens.push(token)
          continue
        }
        if (token.familyId) existing.familyId = token.familyId
        else delete existing.familyId
        existing.fallback = token.fallback
        existing.updatedAt = now
      }
    }
  }

  // ── Root custom properties ─────────────────────────────────────────────────
  for (const planned of plan.customProperties) writeRootProperties(site, planned, 'overwrite', now)

  return { frameworkChanged }
}

function upsertScaleGroups<G extends FrameworkTypographyGroup | FrameworkSpacingGroup>(groups: G[], planned: G[], now: number): void {
  for (const group of planned) {
    const existing = groups.find((g) => g.namingConvention === group.namingConvention)
    if (!existing) {
      groups.push(group)
      continue
    }
    copyScaleSizing(existing, group)
    existing.updatedAt = now
  }
}
