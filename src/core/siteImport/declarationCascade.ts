import type { CSSDeclarationPriorityBag } from '@core/page-tree'
import type { NewStyleRule } from './types'

export interface DeclarationLayer {
  styles: Record<string, unknown>
  priorities: CSSDeclarationPriorityBag
}

export interface CascadedStyleRuleLayers {
  styles: Record<string, unknown>
  stylePriorities: CSSDeclarationPriorityBag
  contextStyles: Record<string, Record<string, unknown>>
  contextStylePriorities: Record<string, CSSDeclarationPriorityBag>
}

export function createCascadedStyleRuleLayers(): CascadedStyleRuleLayers {
  return {
    styles: {},
    stylePriorities: {},
    contextStyles: {},
    contextStylePriorities: {},
  }
}

/**
 * Merge equal-specificity declaration fragments in source order. An existing
 * important declaration resists a later normal declaration; otherwise the
 * later value wins. Re-inserting winners also preserves their later authored
 * position relative to shorthand declarations.
 */
export function mergeDeclarationCascade(
  target: DeclarationLayer,
  incoming: DeclarationLayer,
): void {
  for (const [property, value] of Object.entries(incoming.styles)) {
    const currentImportant = target.priorities[property] === 'important'
    const incomingImportant = incoming.priorities[property] === 'important'
    if (currentImportant && !incomingImportant) continue

    delete target.styles[property]
    target.styles[property] = value
    if (incomingImportant) target.priorities[property] = 'important'
    else delete target.priorities[property]
  }
}

export function mergeStyleRuleCascade(
  target: CascadedStyleRuleLayers,
  incoming: NewStyleRule,
): void {
  mergeDeclarationCascade(
    { styles: target.styles, priorities: target.stylePriorities },
    { styles: incoming.styles, priorities: incoming.stylePriorities ?? {} },
  )
  for (const [contextId, styles] of Object.entries(incoming.contextStyles ?? {})) {
    if (!target.contextStyles[contextId]) target.contextStyles[contextId] = {}
    if (!target.contextStylePriorities[contextId]) target.contextStylePriorities[contextId] = {}
    mergeDeclarationCascade(
      {
        styles: target.contextStyles[contextId],
        priorities: target.contextStylePriorities[contextId],
      },
      {
        styles,
        priorities: incoming.contextStylePriorities?.[contextId] ?? {},
      },
    )
  }
}

export function sparsePriorities(
  priorities: CSSDeclarationPriorityBag,
): CSSDeclarationPriorityBag | undefined {
  return Object.keys(priorities).length > 0 ? priorities : undefined
}
