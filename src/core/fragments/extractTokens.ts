/**
 * Token closure for `extractFragment`: every `var(--x)` the carried content
 * reads, classified by the framework's own generators (see `siteVariables`).
 */

import type { PageNode, StyleRule } from '@core/page-tree'
import type { FontEntry, FontToken } from '@core/fonts'
import type { FrameworkColorToken } from '@core/framework-schema'
import { collectVarNames, declaredFontFamilies, forEachString, nodeContent, ruleContent } from './references'
import { indexSiteVariables, type ScaleFamily } from './siteVariables'
import type { FragmentScaleStep, SiteFragment } from './schema'
import type { FragmentSource } from './source'
import type { FragmentWarning } from './warnings'

/** A framework scale utility (`text-xl`) a carried node uses, by name. */
export interface FrameworkStepUse extends FragmentScaleStep {
  family: ScaleFamily
}

// ---------------------------------------------------------------------------
// 6. Tokens
// ---------------------------------------------------------------------------

export function collectTokens(
  source: FragmentSource,
  rules: StyleRule[],
  allNodes: PageNode[],
  frameworkColorIds: Set<string>,
  frameworkSteps: FrameworkStepUse[],
  warnings: FragmentWarning[],
): SiteFragment['tokens'] {
  const { site } = source
  const index = indexSiteVariables(site)

  const pending = new Set<string>()
  const scan = (text: string) => collectVarNames(text, pending)
  for (const rule of rules) forEachString(ruleContent(rule), scan)
  for (const node of allNodes) forEachString(nodeContent(node), scan)

  // Properties the fragment declares itself (`.card { --pad: 1rem }`) resolve
  // wherever it lands.
  const local = new Set<string>()
  for (const rule of rules) {
    for (const bag of [rule.styles, ...Object.values(rule.contextStyles)]) {
      for (const property of Object.keys(bag)) if (property.startsWith('--')) local.add(property)
    }
  }
  for (const node of allNodes) {
    for (const property of Object.keys(node.inlineStyles ?? {})) if (property.startsWith('--')) local.add(property)
  }

  const colorIds = new Set(frameworkColorIds)
  const steps: Record<ScaleFamily, FragmentScaleStep[]> = { typography: [], spacing: [] }
  for (const use of frameworkSteps) steps[use.family].push({ convention: use.convention, step: use.step })

  const fontTokens = new Map<string, FontToken>()
  const customProperties: Record<string, string> = {}
  const visited = new Set<string>()
  while (pending.size > 0) {
    const [name] = pending
    pending.delete(name)
    if (visited.has(name)) continue
    visited.add(name)

    const colorId = index.colorTokenIdByVar.get(name)
    if (colorId) {
      colorIds.add(colorId)
      continue
    }
    const step = index.scaleStepByVar.get(name)
    if (step) {
      steps[step.family].push({ convention: step.convention, step: step.step })
      continue
    }
    const fontToken = index.fontTokenByVar.get(name)
    if (fontToken) {
      fontTokens.set(fontToken.id, structuredClone(fontToken))
      continue
    }
    if (local.has(name)) continue
    const value = index.rootCustomProperties.get(name)
    if (value !== undefined) {
      customProperties[name] = value
      collectVarNames(value, pending)
      continue
    }
    warnings.push({
      code: 'unresolved-custom-property',
      message: `The styles read ${name}, which the source site does not define at its root.`,
      subject: name,
    })
  }

  const colors: FrameworkColorToken[] = (site.settings.framework?.colors.tokens ?? [])
    .filter((token) => colorIds.has(token.id))
    .map((token) => structuredClone(token))

  const familyIds = new Set([...fontTokens.values()].flatMap((t) => (t.familyId ? [t.familyId] : [])))
  // Families named literally in a carried `font-family` declaration travel too,
  // so a section that never went through a token still finds its face.
  const declaredFamilies = declaredFontFamilies(rules)
  const fontFamilies: FontEntry[] = (site.settings.fonts?.items ?? [])
    .filter((entry) => familyIds.has(entry.id) || declaredFamilies.has(entry.family.toLowerCase()))
    .map((entry) => structuredClone(entry))

  return {
    colors,
    fontTokens: [...fontTokens.values()],
    fontFamilies,
    typeSteps: uniqueSteps(steps.typography),
    spaceSteps: uniqueSteps(steps.spacing),
    customProperties,
  }
}

function uniqueSteps(steps: FragmentScaleStep[]): FragmentScaleStep[] {
  const seen = new Set<string>()
  return steps.filter((s) => {
    const key = `${s.convention}\u0000${s.step}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
