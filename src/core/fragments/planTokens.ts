/**
 * Token merge for `planFragmentInsert`. The site's tokens always win:
 *
 *   - colours match by normalised slug; a missing one is added with the
 *     fragment's FULL definition (generation flags included) so the variants
 *     the fragment reads exist;
 *   - missing type and space groups use the framework defaults; existing
 *     scales extend only where their existing sizes can be preserved;
 *   - font tokens match by variable; a missing one comes with its family
 *     (an existing family of the same name is reused);
 *   - other custom properties the site does not define land in the
 *     engine-owned `:root` rule.
 */

import { nanoid } from 'nanoid'
import type { SiteDocument, StyleRule } from '@core/page-tree'
import {
  generateFrameworkColorVariableSets,
  extendScaleToStep,
  getVariableName,
  makeFreshSpacingGroup,
  makeFreshTypographyGroup,
  normalizeFrameworkColorSlug,
  resolveFrameworkPreferences,
} from '@core/framework'
import type {
  FrameworkColorToken,
  FrameworkSettings,
  FrameworkSpacingGroup,
  FrameworkTypographyGroup,
} from '@core/framework-schema'
import { fontTokenCssVariable, normalizeFontTokenVariable, type FontToken } from '@core/fonts'
import { collectVarNames, declaredFontFamilies, forEachString, nodeContent, ruleContent } from './references'
import { indexSiteVariables, type ScaleFamily } from './siteVariables'
import type { FragmentScaleStep, SiteFragment } from './schema'
import type {
  FragmentInsertReport,
  PlannedCustomProperties,
  PlannedFontFamily,
  PlannedScaleGroups,
  PlannedScaleSteps,
} from './planTypes'
import type { FragmentWarning } from './warnings'

/** `origin.source` of the engine-owned `:root` rule that holds inserted (and applied theme) custom properties. */
export const FRAGMENT_PROPERTIES_ORIGIN = 'instatic:fragment-properties'

export interface TokenPlan {
  colorTokens: FrameworkColorToken[]
  scaleGroups: PlannedScaleGroups
  scaleSteps: PlannedScaleSteps[]
  /** The site's framework settings as they will be after the insert. */
  nextFramework: FrameworkSettings | undefined
  fontFamilies: PlannedFontFamily[]
  fontTokens: FontToken[]
}

export function planTokens(
  site: SiteDocument,
  fragment: SiteFragment,
  report: FragmentInsertReport,
  warnings: FragmentWarning[],
  colorSources: Record<string, string> = {},
): TokenPlan {
  const now = Date.now()
  const framework = site.settings.framework

  // ── Colours ────────────────────────────────────────────────────────────────
  const existingColors = framework?.colors.tokens ?? []
  const slugs = new Set(existingColors.map((t) => normalizeFrameworkColorSlug(t.slug)))
  let colorOrder = existingColors.reduce((max, t) => Math.max(max, t.order), -1)
  const colorTokens: FrameworkColorToken[] = []
  for (const token of fragment.tokens.colors) {
    const slug = normalizeFrameworkColorSlug(token.slug)
    if (slugs.has(slug)) {
      report.colors.kept.push(slug)
      continue
    }
    slugs.add(slug)
    colorOrder += 1
    // The caller may fill a missing colour from one of the site's own, so a
    // section's band takes the site's surface rather than the kit's.
    const sourceSlug = colorSources[slug] ? normalizeFrameworkColorSlug(colorSources[slug]) : null
    const source = sourceSlug ? existingColors.find((t) => normalizeFrameworkColorSlug(t.slug) === sourceSlug) : undefined
    const values = source
      ? { lightValue: source.lightValue, darkValue: source.darkValue, darkModeEnabled: source.darkModeEnabled }
      : {}
    colorTokens.push({ ...structuredClone(token), ...values, id: nanoid(), slug, order: colorOrder, createdAt: now, updatedAt: now })
    report.colors.added.push(slug)
    if (source) report.colors.filled.push({ slug, from: source.slug })
  }

  // ── Scale steps ────────────────────────────────────────────────────────────
  const scaleSteps: PlannedScaleSteps[] = []
  const typography = structuredClone(framework?.typography ?? { groups: [] })
  const spacing = structuredClone(framework?.spacing ?? { groups: [] })
  const colors = { tokens: [...existingColors, ...colorTokens] }
  const variablesBySource = indexSiteVariables({
    settings: { ...site.settings, framework: { ...framework, colors } },
    styleRules: site.styleRules,
  })
  const reserved = new Set<string>([
    ...variablesBySource.scaleStepByVar.keys(),
    ...variablesBySource.colorTokenIdByVar.keys(),
    ...variablesBySource.fontTokenByVar.keys(),
  ])
  for (const token of fragment.tokens.fontTokens) {
    const variable = fontTokenCssVariable(token.variable)
    if (variable) reserved.add(variable)
  }
  const scaleContext = { reserved, updates: scaleSteps, report, warnings }
  const scaleGroups: PlannedScaleGroups = {
    typography: planScale('typography', typography, fragment.tokens.typeSteps,
      (name, order) => makeFreshTypographyGroup(name === 'text' ? 'Typography' : name, name, order), scaleContext),
    spacing: planScale('spacing', spacing, fragment.tokens.spaceSteps,
      (name, order) => makeFreshSpacingGroup(name === 'space' ? 'Spacing' : name, name, order), scaleContext),
  }
  if ((scaleGroups.typography.length || scaleGroups.spacing.length) && !framework?.preferences
    && !framework?.typography?.groups.length && !framework?.spacing?.groups.length) {
    // A scale added to a blank site should use the browser's normal rem size
    // for conversions. Keep the document's own root font size in the cascade.
    scaleGroups.preferences = { ...resolveFrameworkPreferences(undefined), rootFontSize: 16 }
  }

  const nextFramework: FrameworkSettings | undefined = framework || colors.tokens.length || typography.groups.length || spacing.groups.length
    ? {
        ...framework,
        colors,
        ...(scaleGroups.preferences ? { preferences: scaleGroups.preferences } : {}),
        ...(framework?.typography || typography.groups.length ? { typography } : {}),
        ...(framework?.spacing || spacing.groups.length ? { spacing } : {}),
      }
    : undefined

  // ── Fonts ──────────────────────────────────────────────────────────────────
  // Tokens first: a token the site already has (a seeded `font-heading` role,
  // say) is kept, so the family the fragment bound to it is not needed.
  const existingTokens = site.settings.fonts?.tokens ?? []
  const variables = new Set(existingTokens.map((t) => normalizeFontTokenVariable(t.variable)))
  const addedTokens: FontToken[] = []
  for (const token of fragment.tokens.fontTokens) {
    const variable = normalizeFontTokenVariable(token.variable)
    if (variables.has(variable)) {
      report.fonts.tokensKept.push(variable)
      continue
    }
    variables.add(variable)
    addedTokens.push({ ...token, variable })
    report.fonts.tokensAdded.push(variable)
  }

  // Families: the ones an added token binds to, and the ones a carried rule
  // names literally in `font-family`. An existing family of the same name is
  // reused; the rest are installed.
  const declared = declaredFontFamilies(fragment.styleRules)
  const families = site.settings.fonts?.items ?? []
  const fontFamilies: PlannedFontFamily[] = []
  // Fragment family id → the site's family of the same name.
  const reusedFamilyIds = new Map<string, string>()
  for (const family of fragment.tokens.fontFamilies) {
    const needed = addedTokens.some((t) => t.familyId === family.id) || declared.has(family.family.toLowerCase())
    if (!needed) continue
    const match = families.find((f) => f.family.toLowerCase() === family.family.toLowerCase())
    if (match) {
      reusedFamilyIds.set(family.id, match.id)
      report.fonts.familiesKept.push(family.family)
    } else {
      fontFamilies.push({ fragmentFamilyId: family.id, entry: structuredClone(family) })
      report.fonts.familiesAdded.push(family.family)
    }
  }

  let fontOrder = existingTokens.reduce((max, t) => Math.max(max, t.order), -1)
  const fontTokens: FontToken[] = addedTokens.map((token) => {
    fontOrder += 1
    // A family being installed keeps its fragment id here; resolve swaps in
    // the installed entry's id.
    const familyId = token.familyId
      ? reusedFamilyIds.get(token.familyId)
        ?? (fontFamilies.some((f) => f.fragmentFamilyId === token.familyId) ? token.familyId : undefined)
      : undefined
    const { familyId: _sourceFamilyId, ...rest } = token
    return { ...rest, id: nanoid(), ...(familyId ? { familyId } : {}), order: fontOrder, createdAt: now, updatedAt: now }
  })

  return { colorTokens, scaleGroups, scaleSteps, nextFramework, fontFamilies, fontTokens }
}

function planScale<Group extends FrameworkTypographyGroup | FrameworkSpacingGroup>(
  family: ScaleFamily,
  settings: { groups: Group[]; isDisabled?: boolean },
  wanted: FragmentScaleStep[],
  makeGroup: (convention: string, order: number) => Group,
  { reserved, updates, report, warnings }: {
    reserved: Set<string>
    updates: PlannedScaleSteps[]
    report: FragmentInsertReport
    warnings: FragmentWarning[]
  },
): Group[] {
  const addedGroups: Group[] = []
  const disabledConventions = new Set<string>()
  let order = settings.groups.reduce((highest, group) => Math.max(highest, group.order), -1)
  for (const { convention, step } of wanted) {
    const existing = settings.groups.find(group => group.namingConvention === convention)
    if (settings.isDisabled || existing?.isDisabled) {
      if (!disabledConventions.has(convention)) {
        disabledConventions.add(convention)
        warnings.push({
          code: 'missing-scale-group',
          message: `The "${convention}" ${family} scale is disabled, so the fragment cannot add its steps.`,
          subject: convention,
        })
      }
      continue
    }
    const group = existing ?? makeGroup(convention, order + 1)
    if (group.mode === 'fluid_manual') {
      if (!group.manualSizes?.some((size) => size.name === `${convention}-${step}`)) {
        warnings.push({
          code: 'scale-step-not-added',
          message: `The "${group.name}" scale uses manual sizes; add "${step}" there by hand.`,
          subject: `${convention}-${step}`,
        })
      }
      continue
    }
    const next = extendScaleToStep(group.steps, group.baseScaleIndex, step)
    const existingSteps = new Set(existing?.steps.split(',').map(label => label.trim()))
    const newVariables = next?.steps.split(',')
      .filter(label => !existingSteps.has(label))
      .map(label => getVariableName(convention, label)) ?? []
    if (!next || newVariables.some(name => !/^--[\w-]+$/.test(name) || reserved.has(name))) {
      warnings.push({
        code: 'scale-step-not-added',
        message: `Adding "${step}" to the "${group.name}" scale would conflict with the site's variables or existing sizes.`,
        subject: `${convention}-${step}`,
      })
      continue
    }
    if (existing && next.steps === group.steps) continue
    Object.assign(group, next)
    for (const name of newVariables) reserved.add(name)
    report.steps.added.push({ family, convention, step })
    if (!existing) {
      order = group.order
      settings.groups.push(group)
      addedGroups.push(group)
    }
    if (addedGroups.includes(group)) continue
    const planned = updates.find((p) => p.family === family && p.groupId === group.id)
    if (planned) {
      planned.steps = next.steps
      planned.baseScaleIndex = next.baseScaleIndex
    } else {
      updates.push({ family, groupId: group.id, steps: next.steps, baseScaleIndex: next.baseScaleIndex })
    }
  }
  return addedGroups
}

/**
 * The custom properties the site will still lack after the token merge, and
 * the `:root` rule they go into. Also warns, once per variable, about colour
 * variants the fragment reads that the site's version of the colour does not
 * generate (a kept colour with shades turned off, say).
 */
export function planCustomProperties(
  site: SiteDocument,
  fragment: SiteFragment,
  tokens: TokenPlan,
  allocateOrder: () => number,
  report: FragmentInsertReport,
  warnings: FragmentWarning[],
): PlannedCustomProperties | null {
  const after = indexSiteVariables({
    settings: {
      ...site.settings,
      framework: tokens.nextFramework,
      fonts: {
        items: site.settings.fonts?.items ?? [],
        tokens: [...(site.settings.fonts?.tokens ?? []), ...tokens.fontTokens],
      },
    },
    styleRules: site.styleRules,
  })

  // Colour variables the fragment's own definitions generate.
  const fragmentColorVars = new Set(
    generateFrameworkColorVariableSets({ tokens: fragment.tokens.colors }).light.map((v) => v.name),
  )
  const used = new Set<string>()
  const scan = (text: string) => collectVarNames(text, used)
  for (const rule of fragment.styleRules) forEachString(ruleContent(rule), scan)
  for (const node of Object.values(fragment.nodes)) forEachString(nodeContent(node), scan)
  for (const vc of fragment.components) for (const node of Object.values(vc.tree.nodes)) forEachString(nodeContent(node), scan)
  for (const value of Object.values(fragment.tokens.customProperties)) collectVarNames(value, used)
  for (const name of used) {
    if (fragmentColorVars.has(name) && !after.colorTokenIdByVar.has(name)) {
      warnings.push({
        code: 'color-variant-missing',
        message: `${name} is a colour variant the site's version of that colour does not generate.`,
        subject: name,
      })
    }
  }

  const missing: Record<string, string> = {}
  for (const [name, value] of Object.entries(fragment.tokens.customProperties)) {
    const defined = after.rootCustomProperties.has(name)
      || after.colorTokenIdByVar.has(name)
      || after.scaleStepByVar.has(name)
      || after.fontTokenByVar.has(name)
    if (defined) report.customProperties.kept.push(name)
    else {
      missing[name] = value
      report.customProperties.added.push(name)
    }
  }
  if (Object.keys(missing).length === 0) return null

  const owned = findOwnedPropertiesRule(site.styleRules)
  if (owned) return { ruleId: owned.id, order: owned.order, properties: missing }
  return { ruleId: nanoid(), order: allocateOrder(), properties: missing }
}

/** The engine-owned `:root` rule inserted fragments and applied themes write into, if the site has one. */
export function findOwnedPropertiesRule(styleRules: Record<string, StyleRule>): StyleRule | undefined {
  return Object.values(styleRules).find(
    (rule) => rule.kind === 'ambient' && rule.selector === ':root' && rule.origin?.source === FRAGMENT_PROPERTIES_ORIGIN,
  )
}
