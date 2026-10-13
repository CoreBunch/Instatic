/**
 * Token merge for `planFragmentInsert`. The site's tokens always win:
 *
 *   - colours match by normalised slug; a missing one is added with the
 *     fragment's FULL definition (generation flags included) so the variants
 *     the fragment reads exist;
 *   - type and space steps the site's group lacks are inserted into that
 *     group at their canonical position, keeping its base, ratio and sizes;
 *   - font tokens match by variable; a missing one comes with its family
 *     (an existing family of the same name is reused);
 *   - other custom properties the site does not define land in the
 *     engine-owned `:root` rule.
 */

import { nanoid } from 'nanoid'
import type { SiteDocument } from '@core/page-tree'
import {
  generateFrameworkColorVariableSets,
  insertScaleStep,
  normalizeFrameworkColorSlug,
} from '@core/framework'
import type {
  FrameworkColorToken,
  FrameworkSettings,
  FrameworkSpacingGroup,
  FrameworkTypographyGroup,
} from '@core/framework-schema'
import { normalizeFontTokenVariable, type FontToken } from '@core/fonts'
import { collectVarNames, declaredFontFamilies, forEachString, nodeContent, ruleContent } from './references'
import { indexSiteVariables, type ScaleFamily } from './siteVariables'
import type { FragmentScaleStep, SiteFragment } from './schema'
import type {
  FragmentInsertReport,
  PlannedCustomProperties,
  PlannedFontFamily,
  PlannedScaleSteps,
} from './planTypes'
import type { FragmentWarning } from './warnings'

/** `origin.source` of the engine-owned `:root` rule that holds inserted custom properties. */
export const FRAGMENT_PROPERTIES_ORIGIN = 'instatic:fragment-properties'

export interface TokenPlan {
  colorTokens: FrameworkColorToken[]
  scaleSteps: PlannedScaleSteps[]
  /** The site's framework settings as they will be after the insert. */
  nextFramework: FrameworkSettings | undefined
  fontFamilies: PlannedFontFamily[]
  /** fragment family id → site family id, for families the site already has. */
  reusedFamilyIds: Map<string, string>
  fontTokens: FontToken[]
}

export function planTokens(
  site: SiteDocument,
  fragment: SiteFragment,
  report: FragmentInsertReport,
  warnings: FragmentWarning[],
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
    colorTokens.push({ ...structuredClone(token), id: nanoid(), slug, order: colorOrder, createdAt: now, updatedAt: now })
    report.colors.added.push(slug)
  }

  // ── Scale steps ────────────────────────────────────────────────────────────
  const scaleSteps: PlannedScaleSteps[] = []
  const typography = framework?.typography ? structuredClone(framework.typography) : undefined
  const spacing = framework?.spacing ? structuredClone(framework.spacing) : undefined
  addSteps('typography', typography, fragment.tokens.typeSteps, scaleSteps, report, warnings)
  addSteps('spacing', spacing, fragment.tokens.spaceSteps, scaleSteps, report, warnings)

  const nextFramework: FrameworkSettings | undefined = framework || colorTokens.length > 0
    ? {
        ...(framework ?? { colors: { tokens: [] } }),
        colors: { tokens: [...existingColors, ...colorTokens] },
        ...(typography ? { typography } : {}),
        ...(spacing ? { spacing } : {}),
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

  return { colorTokens, scaleSteps, nextFramework, fontFamilies, reusedFamilyIds, fontTokens }
}

function addSteps(
  family: ScaleFamily,
  settings: { groups: (FrameworkTypographyGroup | FrameworkSpacingGroup)[]; isDisabled?: boolean } | undefined,
  wanted: FragmentScaleStep[],
  out: PlannedScaleSteps[],
  report: FragmentInsertReport,
  warnings: FragmentWarning[],
): void {
  const missingConventions = new Set<string>()
  for (const { convention, step } of wanted) {
    const group = settings && !settings.isDisabled
      ? settings.groups.find((g) => g.namingConvention === convention && !g.isDisabled)
      : undefined
    if (!group) {
      if (!missingConventions.has(convention)) {
        missingConventions.add(convention)
        warnings.push({
          code: 'missing-scale-group',
          message: `The site has no ${family} scale named "${convention}"; styles reading --${convention}-* fall back.`,
          subject: convention,
        })
      }
      continue
    }
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
    const next = insertScaleStep(group.steps, group.baseScaleIndex, step)
    if (!next) {
      warnings.push({
        code: 'scale-step-not-added',
        message: `"${step}" has no canonical place in the "${group.name}" scale (${group.steps}).`,
        subject: `${convention}-${step}`,
      })
      continue
    }
    if (next.steps === group.steps) continue
    group.steps = next.steps
    group.baseScaleIndex = next.baseScaleIndex
    const planned = out.find((p) => p.family === family && p.groupId === group.id)
    if (planned) {
      planned.steps = next.steps
      planned.baseScaleIndex = next.baseScaleIndex
    } else {
      out.push({ family, groupId: group.id, steps: next.steps, baseScaleIndex: next.baseScaleIndex })
    }
    report.steps.added.push({ family, convention, step })
  }
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

  const owned = Object.values(site.styleRules).find(
    (rule) => rule.kind === 'ambient' && rule.selector === ':root' && rule.origin?.source === FRAGMENT_PROPERTIES_ORIGIN,
  )
  if (owned) return { ruleId: owned.id, order: owned.order, properties: missing }
  return { ruleId: nanoid(), order: allocateOrder(), properties: missing }
}
