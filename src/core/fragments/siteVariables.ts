/**
 * Which CSS custom properties a site defines, and where each comes from.
 *
 * Built from the framework's own generators (`generateFrameworkColorVariableSets`,
 * `generateFrameworkTypographyVariables`, `generateFrameworkSpacingVariables`)
 * and the font-token naming helper, so a `var(--primary-d-2)` is classified by
 * exactly the code that emits `--primary-d-2` — never by a parallel regex
 * that could drift from it.
 */

import type { SiteSettings, StyleRule } from '@core/page-tree'
import {
  generateFrameworkColorVariableSets,
  generateFrameworkSpacingVariables,
  generateFrameworkTypographyVariables,
  resolveFrameworkPreferences,
} from '@core/framework'
import { fontTokenCssVariable, type FontToken } from '@core/fonts'

export type ScaleFamily = 'typography' | 'spacing'

export interface ScaleStepRef {
  family: ScaleFamily
  groupId: string
  /** The group's `namingConvention` (`text`, `space`). */
  convention: string
  step: string
}

export interface SiteVariableIndex {
  /** Every colour variable (base + generated variants, light + dark) → token id. */
  colorTokenIdByVar: Map<string, string>
  scaleStepByVar: Map<string, ScaleStepRef>
  fontTokenByVar: Map<string, FontToken>
  /** `--name` → value declared on a root-scope ambient rule (last in cascade wins). */
  rootCustomProperties: Map<string, string>
}

const ROOT_SCOPE_SELECTORS = new Set([':root', 'html', 'body'])

/**
 * A selector that targets only the document root: `:root`, `html`, `body`, or
 * a comma group of those. Qualified selectors (`:root.theme-alt`) are not root
 * scope — their variables apply conditionally.
 */
export function isRootScopeSelector(selector: string): boolean {
  const parts = selector.split(',').map((part) => part.trim().toLowerCase())
  return parts.length > 0 && parts.every((part) => ROOT_SCOPE_SELECTORS.has(part))
}

export function indexSiteVariables(site: {
  settings: SiteSettings
  styleRules: Record<string, StyleRule>
}): SiteVariableIndex {
  const framework = site.settings.framework
  const colorTokenIdByVar = new Map<string, string>()
  const colorSets = generateFrameworkColorVariableSets(framework?.colors)
  for (const variable of [...colorSets.light, ...colorSets.dark]) {
    colorTokenIdByVar.set(variable.name, variable.tokenId)
  }

  const scaleStepByVar = new Map<string, ScaleStepRef>()
  const preferences = resolveFrameworkPreferences(framework?.preferences)
  const typographyConventions = new Map(
    (framework?.typography?.groups ?? []).map((group) => [group.id, group.namingConvention]),
  )
  for (const variable of generateFrameworkTypographyVariables(framework?.typography, preferences)) {
    scaleStepByVar.set(variable.name, {
      family: 'typography',
      groupId: variable.groupId,
      convention: typographyConventions.get(variable.groupId) ?? '',
      step: variable.step,
    })
  }
  const spacingConventions = new Map(
    (framework?.spacing?.groups ?? []).map((group) => [group.id, group.namingConvention]),
  )
  for (const variable of generateFrameworkSpacingVariables(framework?.spacing, preferences)) {
    scaleStepByVar.set(variable.name, {
      family: 'spacing',
      groupId: variable.groupId,
      convention: spacingConventions.get(variable.groupId) ?? '',
      step: variable.step,
    })
  }

  const fontTokenByVar = new Map<string, FontToken>()
  for (const token of site.settings.fonts?.tokens ?? []) {
    const name = fontTokenCssVariable(token.variable)
    if (name) fontTokenByVar.set(name, token)
  }

  const rootCustomProperties = new Map<string, string>()
  const rootRules = Object.values(site.styleRules)
    .filter((rule) => rule.kind === 'ambient' && isRootScopeSelector(rule.selector))
    .sort((a, b) => a.order - b.order)
  for (const rule of rootRules) {
    for (const [property, value] of Object.entries(rule.styles)) {
      if (property.startsWith('--') && typeof value === 'string') {
        rootCustomProperties.set(property, value)
      }
    }
  }

  return { colorTokenIdByVar, scaleStepByVar, fontTokenByVar, rootCustomProperties }
}
