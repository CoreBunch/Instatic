/**
 * planStylesheetEdit — edited stylesheet text → a registry edit plan.
 *
 * The text is parsed with the same `cssToStyleRules` the importer and the
 * MCP `site_apply_css` tool use (breakpoint-aware `@media` folding), then
 * diffed against the projection it was derived from:
 *
 *   - every parsed rule is an upsert by exact selector (replace semantics —
 *     the block's declarations are authoritative),
 *   - a projected class block whose selector vanished is CLEARED (its
 *     declarations go, the class and its assignments stay — the CSS panel
 *     edits CSS, never `class=` attributes),
 *   - a projected ambient block whose selector vanished is DELETED (nothing
 *     references an ambient rule but its CSS),
 *   - the reserved `element` block becomes the node's inline styles,
 *   - a rule addressed at a locked (framework) block is reported as blocked
 *     and never applied.
 *
 * Pure: the store applies the plan atomically (`applyStylesheetEdit`).
 */
import type { ConditionDef } from '@core/page-tree'
import { cssToStyleRules, type BreakpointHint, type NewStyleRule } from '@core/siteImport'
import { ELEMENT_BLOCK_SELECTOR } from './projectStylesheet'
import type { StylesheetProjection } from './types'

export interface StylesheetEdit {
  /** Rules to upsert by exact selector, in authored order. */
  rules: NewStyleRule[]
  /** Reusable conditions referenced by `rules[].contextStyles`. */
  conditions: ConditionDef[]
  /** Class rules whose block was removed: declarations cleared, rule kept. */
  clearedClassIds: string[]
  /** Ambient rules whose block was removed: deleted from the registry. */
  deletedAmbientIds: string[]
  /** Replacement inline-style bag for the projected node, or `null` when the projection had no element block. */
  inlineStyles: { nodeId: string; styles: Record<string, unknown> } | null
}

export interface StylesheetEditPlan {
  edit: StylesheetEdit
  /** Selectors the text tried to change that belong to read-only framework blocks. */
  blockedSelectors: string[]
  /** Human-readable notes about dropped or ignored input. */
  warnings: string[]
}

export interface StylesheetEditPlanInput {
  text: string
  /** The projection the text was derived from — defines what a removed block means. */
  projection: StylesheetProjection
  breakpoints: BreakpointHint[]
}

/** Comparison key for a parsed rule's declaration layers (selector aside). */
function declarationKey(rule: NewStyleRule): string {
  return JSON.stringify([
    rule.styles,
    rule.stylePriorities ?? null,
    rule.contextStyles,
    rule.contextStylePriorities ?? null,
  ])
}

export function planStylesheetEdit(input: StylesheetEditPlanInput): StylesheetEditPlan {
  const parsed = cssToStyleRules(input.text, { breakpoints: input.breakpoints })
  const warnings = parsed.warnings.map((warning) => warning.message)

  // Locked blocks are compared against their own projected text so a
  // re-parse of an untouched framework block is not reported as an edit.
  const lockedPayloads = new Map<string, string>()
  for (const block of input.projection.blocks) {
    if (!block.locked) continue
    const own = cssToStyleRules(input.projection.text.slice(block.from, block.to), {
      breakpoints: input.breakpoints,
    })
    const ownRule = own.rules.find((rule) => rule.selector === block.selector)
    if (ownRule) lockedPayloads.set(block.selector, declarationKey(ownRule))
  }
  const inlineBlock = input.projection.blocks.find((block) => block.origin === 'inline') ?? null

  const rules: NewStyleRule[] = []
  const blockedSelectors: string[] = []
  let inlineStyles: StylesheetEdit['inlineStyles'] = inlineBlock?.nodeId
    ? { nodeId: inlineBlock.nodeId, styles: {} }
    : null

  for (const rule of parsed.rules) {
    if (rule.selector === ELEMENT_BLOCK_SELECTOR) {
      if (!inlineStyles) {
        warnings.push(
          `The \`${ELEMENT_BLOCK_SELECTOR}\` block is ignored while no element is selected.`,
        )
        continue
      }
      if (Object.keys(rule.contextStyles).length > 0) {
        warnings.push(
          'Inline styles cannot be breakpoint- or condition-scoped; the @media/@container/@supports overrides of the `element` block were dropped.',
        )
      }
      // Later `element` blocks layer over earlier ones, like the cascade.
      inlineStyles = { nodeId: inlineStyles.nodeId, styles: { ...inlineStyles.styles, ...rule.styles } }
      continue
    }
    const lockedPayload = lockedPayloads.get(rule.selector)
    if (lockedPayload !== undefined) {
      if (
        lockedPayload !== declarationKey(rule)
        && !blockedSelectors.includes(rule.selector)
      ) {
        blockedSelectors.push(rule.selector)
      }
      continue
    }
    rules.push(rule)
  }

  const presentSelectors = new Set(parsed.rules.map((rule) => rule.selector))
  const clearedClassIds: string[] = []
  const deletedAmbientIds: string[] = []
  for (const block of input.projection.blocks) {
    if (block.locked || block.ruleId === null || presentSelectors.has(block.selector)) continue
    if (block.origin === 'ambient') deletedAmbientIds.push(block.ruleId)
    else clearedClassIds.push(block.ruleId)
  }

  return {
    edit: {
      rules,
      conditions: parsed.conditions,
      clearedClassIds,
      deletedAmbientIds,
      inlineStyles,
    },
    blockedSelectors,
    warnings,
  }
}
