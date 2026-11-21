/**
 * planThemeApply — decide what applying a theme changes in a site, and
 * report it with before → after values, without changing anything. Pure.
 *
 * A fragment insert never overwrites what a site has; a theme does, by
 * design. Only design variables are touched, never nodes, classes, pages,
 * components or tables:
 *
 *   - colours: matched by normalised slug; the site's token keeps its id,
 *     order and category and takes the theme's definition (light and dark
 *     values, dark-mode flag, generation flags); missing ones are added;
 *   - font tokens: matched by variable; the site's token is rebound to the
 *     theme's family (reused by name, else installed) and takes its fallback
 *     stack; missing ones are added;
 *   - scale groups: matched by `namingConvention` per family; the site's group
 *     takes the theme's sizing (min/max size and ratio, steps, base step,
 *     mode, manual sizes); missing groups are added;
 *   - custom properties: a value a site root rule declares is overwritten in
 *     that rule; anything else goes into the engine-owned `:root` rule
 *     (`FRAGMENT_PROPERTIES_ORIGIN`).
 *
 * A value the site already has is reported as kept, not changed.
 */

import { nanoid } from 'nanoid'
import { createStyleRuleOrderAllocator, type SiteDocument } from '@core/page-tree'
import { effectiveScaleRatio, normalizeFrameworkColorSlug } from '@core/framework'
import type {
  FrameworkColorToken,
  FrameworkSpacingGroup,
  FrameworkTypographyGroup,
} from '@core/framework-schema'
import { normalizeFontTokenVariable, type FontToken } from '@core/fonts'
import { deepEqual } from '@core/utils/deepEqual'
import { referencedMedia } from './planData'
import { findOwnedPropertiesRule } from './planTokens'
import { indexSiteVariables, type ScaleFamily } from './siteVariables'
import type { PlannedCustomProperties, PlannedFontFamily } from './planTypes'
import type { FragmentMedia } from './schema'
import type { SiteTheme } from './themeSchema'
import type { FragmentWarning } from './warnings'

export interface ThemeApplyTarget {
  site: SiteDocument
}

export interface ThemeColorValues {
  lightValue: string
  darkValue: string
  darkModeEnabled: boolean
}

/** A scale group's sizing, as the report shows it. Sizes in px; `baseStep` is the step label at the base index. */
export interface ThemeScaleSizing {
  minSize: number
  maxSize: number
  minRatio: number
  maxRatio: number
  steps: string
  baseStep: string
}

export interface ThemeApplyReport {
  colors: {
    changed: { slug: string; before: ThemeColorValues; after: ThemeColorValues }[]
    added: { slug: string; after: ThemeColorValues }[]
    kept: string[]
  }
  fonts: {
    /** Family names; null for a token with no family (fallback stack only). */
    tokensRebound: { variable: string; before: string | null; after: string | null }[]
    tokensAdded: { variable: string; family: string | null }[]
    tokensKept: string[]
    familiesToInstall: string[]
    /** Theme families the site already has (same name), reused as they are. */
    familiesReused: string[]
  }
  scales: {
    changed: { family: ScaleFamily; convention: string; before: ThemeScaleSizing; after: ThemeScaleSizing }[]
    added: { family: ScaleFamily; convention: string; after: ThemeScaleSizing }[]
    kept: { family: ScaleFamily; convention: string }[]
  }
  customProperties: {
    changed: { name: string; before: string; after: string }[]
    added: { name: string; value: string }[]
    kept: string[]
  }
  /** `total` from the plan; `uploaded` and `reused` once committed. */
  media: { total: number; uploaded: number; reused: number }
  warnings: FragmentWarning[]
}

type ScaleGroup = FrameworkTypographyGroup | FrameworkSpacingGroup

/** A scale group to write: the site's group with the theme's sizing (`replace`), or a new one (`add`). */
export interface PlannedThemeScaleGroup<G extends ScaleGroup> {
  action: 'replace' | 'add'
  group: G
}

export interface PlannedThemeFontToken {
  /** `rebind` an existing token (matched by variable), or `add` a new one. */
  action: 'rebind' | 'add'
  /** The token as written; `familyId` is set only for a family the site already has. */
  token: FontToken
  /**
   * The theme family (`PlannedFontFamily.fragmentFamilyId`) the token binds to
   * once the commit installs it. If the install fails, a rebound token keeps
   * its current family and an added one falls back to its stack.
   */
  installFamilyId?: string
}

/**
 * Everything applying a theme writes, ids minted. Colours, font tokens and
 * scale groups are matched again by slug, variable and convention when they
 * are applied, so the plan stays correct if the site gained one meanwhile.
 */
export interface ThemeApplyPlan {
  /** Changed (the site token's id and order) and added colour tokens. */
  colors: FrameworkColorToken[]
  fontFamilies: PlannedFontFamily[]
  fontTokens: PlannedThemeFontToken[]
  scaleGroups: {
    typography: PlannedThemeScaleGroup<FrameworkTypographyGroup>[]
    spacing: PlannedThemeScaleGroup<FrameworkSpacingGroup>[]
  }
  /** Per target rule: a site root rule, or the engine-owned `:root` rule. */
  customProperties: PlannedCustomProperties[]
  /** Custom font files and media changed custom properties reference. */
  media: FragmentMedia[]
  report: ThemeApplyReport
}

/** The colour token fields a theme owns; the rest (id, slug, order, category, timestamps) stay the site's. */
export function themeColorDefinition(token: FrameworkColorToken) {
  return {
    lightValue: token.lightValue,
    darkValue: token.darkValue,
    darkModeEnabled: token.darkModeEnabled,
    generateUtilities: token.generateUtilities,
    generateTransparent: token.generateTransparent,
    generateShades: token.generateShades,
    generateTints: token.generateTints,
  }
}

/**
 * Give `target` the sizing of `source`: mode, min and max (size and ratio),
 * steps, base step and manual sizes. Name, id, order, generators and the
 * disabled flag stay the target's.
 */
export function copyScaleSizing<G extends ScaleGroup>(target: G, source: G): void {
  target.mode = source.mode
  target.min = structuredClone(source.min)
  target.max = structuredClone(source.max)
  target.steps = source.steps
  target.baseScaleIndex = source.baseScaleIndex
  if (source.manualSizes) target.manualSizes = structuredClone(source.manualSizes)
  else delete target.manualSizes
}

function sameScaleSizing(a: ScaleGroup, b: ScaleGroup): boolean {
  return a.mode === b.mode
    && deepEqual(a.min, b.min)
    && deepEqual(a.max, b.max)
    && a.steps === b.steps
    && a.baseScaleIndex === b.baseScaleIndex
    && deepEqual(a.manualSizes ?? [], b.manualSizes ?? [])
}

export function planThemeApply(target: ThemeApplyTarget, theme: SiteTheme): ThemeApplyPlan {
  const { site } = target
  const now = Date.now()
  const report = emptyThemeReport()
  const warnings: FragmentWarning[] = []

  const colors = planColors(site, theme, now, report)
  const { fontFamilies, fontTokens } = planFonts(site, theme, now, report)
  const scaleGroups = {
    typography: planScaleGroups('typography', site.settings.framework?.typography?.groups ?? [], theme.typography, now, report, warnings),
    spacing: planScaleGroups('spacing', site.settings.framework?.spacing?.groups ?? [], theme.spacing, now, report, warnings),
  }
  const customProperties = planThemeProperties(site, theme, report)

  const media = referencedMedia(theme.media, {
    fontFamilies,
    customProperties: customProperties.map((planned) => planned.properties),
  })
  report.media.total = media.length
  report.warnings = warnings

  return { colors, fontFamilies, fontTokens, scaleGroups, customProperties, media, report }
}

function emptyThemeReport(): ThemeApplyReport {
  return {
    colors: { changed: [], added: [], kept: [] },
    fonts: { tokensRebound: [], tokensAdded: [], tokensKept: [], familiesToInstall: [], familiesReused: [] },
    scales: { changed: [], added: [], kept: [] },
    customProperties: { changed: [], added: [], kept: [] },
    media: { total: 0, uploaded: 0, reused: 0 },
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

function colorValues(token: FrameworkColorToken): ThemeColorValues {
  return { lightValue: token.lightValue, darkValue: token.darkValue, darkModeEnabled: token.darkModeEnabled }
}

function planColors(site: SiteDocument, theme: SiteTheme, now: number, report: ThemeApplyReport): FrameworkColorToken[] {
  const existing = site.settings.framework?.colors.tokens ?? []
  const bySlug = new Map(existing.map((t) => [normalizeFrameworkColorSlug(t.slug), t]))
  let order = existing.reduce((max, t) => Math.max(max, t.order), -1)
  const out: FrameworkColorToken[] = []
  for (const token of theme.colors) {
    const slug = normalizeFrameworkColorSlug(token.slug)
    const current = bySlug.get(slug)
    if (current) {
      if (deepEqual(themeColorDefinition(current), themeColorDefinition(token))) {
        report.colors.kept.push(slug)
        continue
      }
      out.push({ ...structuredClone(current), ...structuredClone(themeColorDefinition(token)), updatedAt: now })
      report.colors.changed.push({ slug, before: colorValues(current), after: colorValues(token) })
      continue
    }
    order += 1
    const added = { ...structuredClone(token), id: nanoid(), slug, order, createdAt: now, updatedAt: now }
    bySlug.set(slug, added)
    out.push(added)
    report.colors.added.push({ slug, after: colorValues(token) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

function planFonts(
  site: SiteDocument,
  theme: SiteTheme,
  now: number,
  report: ThemeApplyReport,
): { fontFamilies: PlannedFontFamily[]; fontTokens: PlannedThemeFontToken[] } {
  const siteFamilies = site.settings.fonts?.items ?? []
  const siteTokens = site.settings.fonts?.tokens ?? []
  const themeFamilies = new Map(theme.fontFamilies.map((f) => [f.id, f]))
  const fontFamilies: PlannedFontFamily[] = []

  // Theme family id → the site family of the same name, or null when it is installed.
  const decided = new Map<string, string | null>()
  const bindFamily = (themeFamilyId: string): { familyId?: string; installFamilyId?: string } => {
    if (!decided.has(themeFamilyId)) {
      const entry = themeFamilies.get(themeFamilyId)!
      const match = siteFamilies.find((f) => f.family.toLowerCase() === entry.family.toLowerCase())
      if (match) report.fonts.familiesReused.push(entry.family)
      else {
        fontFamilies.push({ fragmentFamilyId: themeFamilyId, entry: structuredClone(entry) })
        report.fonts.familiesToInstall.push(entry.family)
      }
      decided.set(themeFamilyId, match?.id ?? null)
    }
    const siteFamilyId = decided.get(themeFamilyId)
    return siteFamilyId ? { familyId: siteFamilyId } : { installFamilyId: themeFamilyId }
  }

  let order = siteTokens.reduce((max, t) => Math.max(max, t.order), -1)
  const fontTokens: PlannedThemeFontToken[] = []
  for (const token of theme.fontTokens) {
    const variable = normalizeFontTokenVariable(token.variable)
    const themeFamily = token.familyId ? themeFamilies.get(token.familyId) : undefined
    const after = themeFamily?.family ?? null
    const { familyId: _themeFamilyId, ...themeRest } = token
    const current = siteTokens.find((t) => normalizeFontTokenVariable(t.variable) === variable)

    if (current) {
      const before = (current.familyId && siteFamilies.find((f) => f.id === current.familyId)?.family) || null
      const sameFamily = before?.toLowerCase() === after?.toLowerCase()
      if (sameFamily && current.fallback === token.fallback) {
        report.fonts.tokensKept.push(variable)
        continue
      }
      const { familyId: _currentFamilyId, ...currentRest } = current
      const binding = !themeFamily ? {} : sameFamily && current.familyId ? { familyId: current.familyId } : bindFamily(themeFamily.id)
      fontTokens.push({
        action: 'rebind',
        token: {
          ...structuredClone(currentRest),
          ...(binding.familyId ? { familyId: binding.familyId } : {}),
          fallback: token.fallback,
          updatedAt: now,
        },
        ...(binding.installFamilyId ? { installFamilyId: binding.installFamilyId } : {}),
      })
      report.fonts.tokensRebound.push({ variable, before, after })
      continue
    }

    order += 1
    const binding = themeFamily ? bindFamily(themeFamily.id) : {}
    fontTokens.push({
      action: 'add',
      token: {
        ...structuredClone(themeRest),
        variable,
        id: nanoid(),
        ...(binding.familyId ? { familyId: binding.familyId } : {}),
        order,
        createdAt: now,
        updatedAt: now,
      },
      ...(binding.installFamilyId ? { installFamilyId: binding.installFamilyId } : {}),
    })
    report.fonts.tokensAdded.push({ variable, family: after })
  }
  return { fontFamilies, fontTokens }
}

// ---------------------------------------------------------------------------
// Scale groups
// ---------------------------------------------------------------------------

function scaleSizing(group: ScaleGroup): ThemeScaleSizing {
  const size = (config: { fontSize: number } | { size: number }) => ('fontSize' in config ? config.fontSize : config.size)
  return {
    minSize: size(group.min),
    maxSize: size(group.max),
    minRatio: effectiveScaleRatio(group.min.scaleRatio, group.min.isCustomScaleRatio, group.min.scaleRatioInputValue),
    maxRatio: effectiveScaleRatio(group.max.scaleRatio, group.max.isCustomScaleRatio, group.max.scaleRatioInputValue),
    steps: group.steps,
    baseStep: splitSteps(group.steps)[group.baseScaleIndex] ?? '',
  }
}

function splitSteps(steps: string): string[] {
  return steps.split(',').map((s) => s.trim()).filter(Boolean)
}

function planScaleGroups<G extends ScaleGroup>(
  family: ScaleFamily,
  existing: G[],
  wanted: G[],
  now: number,
  report: ThemeApplyReport,
  warnings: FragmentWarning[],
): PlannedThemeScaleGroup<G>[] {
  const out: PlannedThemeScaleGroup<G>[] = []
  let order = existing.reduce((max, g) => Math.max(max, g.order), -1)
  for (const group of wanted) {
    const convention = group.namingConvention
    const current = existing.find((g) => g.namingConvention === convention)
    if (current) {
      if (sameScaleSizing(current, group)) {
        report.scales.kept.push({ family, convention })
        continue
      }
      const next = structuredClone(current)
      copyScaleSizing(next, group)
      next.updatedAt = now
      out.push({ action: 'replace', group: next })
      report.scales.changed.push({ family, convention, before: scaleSizing(current), after: scaleSizing(group) })
      const kept = new Set(splitSteps(group.steps))
      const removed = splitSteps(current.steps).filter((step) => !kept.has(step))
      if (current.mode !== 'fluid_manual' && removed.length > 0) {
        warnings.push({
          code: 'scale-step-removed',
          message: `The "${current.name}" scale no longer has ${removed.join(', ')}; styles reading ${removed.map((s) => `--${convention}-${s}`).join(', ')} fall back.`,
          subject: convention,
        })
      }
      continue
    }
    order += 1
    out.push({ action: 'add', group: { ...structuredClone(group), id: nanoid(), order, createdAt: now, updatedAt: now } })
    report.scales.added.push({ family, convention, after: scaleSizing(group) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Custom properties
// ---------------------------------------------------------------------------

function planThemeProperties(site: SiteDocument, theme: SiteTheme, report: ThemeApplyReport): PlannedCustomProperties[] {
  const index = indexSiteVariables(site)
  const byRule = new Map<string, PlannedCustomProperties>()
  let owned: { ruleId: string; order: number } | null = null
  const ownedRule = () => {
    if (!owned) {
      const rule = findOwnedPropertiesRule(site.styleRules)
      owned = rule
        ? { ruleId: rule.id, order: rule.order }
        : { ruleId: nanoid(), order: createStyleRuleOrderAllocator(site.styleRules)() }
    }
    return owned
  }

  for (const [name, value] of Object.entries(theme.customProperties)) {
    const before = index.rootCustomProperties.get(name)
    if (before === value) {
      report.customProperties.kept.push(name)
      continue
    }
    const declaringRuleId = index.rootCustomPropertyRuleIds.get(name)
    const target = declaringRuleId
      ? { ruleId: declaringRuleId, order: site.styleRules[declaringRuleId].order }
      : ownedRule()
    const planned = byRule.get(target.ruleId) ?? { ...target, properties: {} }
    planned.properties[name] = value
    byRule.set(target.ruleId, planned)
    if (before === undefined) report.customProperties.added.push({ name, value })
    else report.customProperties.changed.push({ name, before, after: value })
  }
  return [...byRule.values()]
}
