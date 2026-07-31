import {
  aiToolError,
  aiToolOk,
  type AiToolOutput,
  type ApplyCssExecutionInput,
} from '@core/ai'
import type { ConditionDef } from '@core/page-tree'
import { cssToStyleRules, type NewStyleRule } from '@core/siteImport'
import type { EditorStore } from '@site/store/types'
import { getAgentStoreApi } from './storeRef'

// Live access to the editor store. Routed through `./storeRef` so this module
// has no static import edge back into `editor-store/store.ts`.
const getStoreState = (): EditorStore => getAgentStoreApi<EditorStore>().getState()

/**
 * Parse CSS harvested from agent-supplied HTML into registry rules. The live
 * site's viewport contexts let matching `@media` rules fold into the
 * corresponding context; unmatched conditions remain reusable site rules.
 */
export function parseImportedStyleCss(styleCss: string): {
  rules: NewStyleRule[]
  conditions: ConditionDef[]
} {
  if (!styleCss.trim()) return { rules: [], conditions: [] }
  const site = getStoreState().site
  const breakpoints = site
    ? site.breakpoints.map((breakpoint) => ({
        id: breakpoint.id,
        width: breakpoint.width,
        mediaQuery: breakpoint.mediaQuery,
      }))
    : []
  const { rules, conditions } = cssToStyleRules(styleCss, { breakpoints })
  return { rules, conditions }
}

/** Apply an exact-selector CSS mutation to the live site's style registry. */
export function runApplyCss(input: ApplyCssExecutionInput): AiToolOutput {
  if (input.operation === 'delete') {
    const result = getStoreState().deleteCssRules(input.selectors)
    if (result.missingSelectors.length > 0) {
      return aiToolError(`CSS selectors not found: ${result.missingSelectors.join(', ')}`)
    }
    if (result.blockedSelectors.length > 0) {
      return aiToolError(
        `Framework-generated CSS selectors are locked: ${result.blockedSelectors.join(', ')}`,
      )
    }
    return aiToolOk({ cssRulesDeleted: result.deleted })
  }

  if (input.operation === 'remove-properties') {
    const result = getStoreState().removeCssRuleProperties(input.selectors, input.properties)
    if (result.missingSelectors.length > 0) {
      return aiToolError(`CSS selectors not found: ${result.missingSelectors.join(', ')}`)
    }
    if (result.blockedSelectors.length > 0) {
      return aiToolError(
        `Framework-generated CSS selectors are locked: ${result.blockedSelectors.join(', ')}`,
      )
    }
    if (result.missingProperties.length > 0) {
      return aiToolError(
        `CSS properties are not set on the requested selectors: ${result.missingProperties.join(', ')}`,
      )
    }
    return aiToolOk({
      cssRulesUpdated: result.updated,
      cssPropertiesRemoved: result.removed,
    })
  }

  const { rules, conditions } = parseImportedStyleCss(input.css)
  if (rules.length === 0) {
    return aiToolError(
      'No CSS rules parsed. Provide CSS like ".hero { color: var(--primary) }" or ' +
        '"nav a:hover { text-decoration: underline }".',
    )
  }
  const result = getStoreState().applyCssRules(rules, conditions, input.operation)
  if (result.blockedSelectors.length > 0) {
    return aiToolError(
      `Framework-generated CSS selectors are locked: ${result.blockedSelectors.join(', ')}`,
    )
  }
  return aiToolOk({ cssRulesCreated: result.created, cssRulesUpdated: result.updated })
}
