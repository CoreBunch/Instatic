import type { ConditionDef, StyleRule } from '@core/page-tree'
import type { ViewportContext } from '@core/publisher'

/**
 * Where a projected block comes from. `framework` is a generated utility class
 * (locked everywhere else in the editor, shown here read-only so the cascade
 * never lies); `inline` is the selected node's `inlineStyles` bag.
 */
export type StylesheetBlockOrigin = 'class' | 'ambient' | 'framework' | 'inline'

export interface StylesheetRuleBlockInput {
  kind: 'rule'
  rule: StyleRule
  /**
   * How many elements the rule reaches: assignments site-wide for a class
   * rule, matches on the current page for an ambient rule.
   */
  usage: number
}

export interface StylesheetInlineBlockInput {
  kind: 'inline'
  nodeId: string
  styles: Record<string, unknown>
}

export type StylesheetBlockInput = StylesheetRuleBlockInput | StylesheetInlineBlockInput

export interface StylesheetProjectionInput {
  /** Blocks in the order they should appear in the stylesheet. */
  blocks: readonly StylesheetBlockInput[]
  breakpoints: ViewportContext[]
  conditions: readonly ConditionDef[]
}

export interface StylesheetProjectionBlock {
  origin: StylesheetBlockOrigin
  /** Registry rule id; `null` for the inline `element` block. */
  ruleId: string | null
  /** The emitted selector (`element` for the inline block). */
  selector: string
  /** Character range of the block: header comment through the last `}`. */
  from: number
  to: number
  /** Read-only in the panel — framework utilities. */
  locked: boolean
  /** Node whose `inlineStyles` the block projects (inline blocks only). */
  nodeId: string | null
}

export interface StylesheetProjection {
  text: string
  blocks: StylesheetProjectionBlock[]
}
