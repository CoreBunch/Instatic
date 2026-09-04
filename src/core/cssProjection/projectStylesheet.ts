/**
 * projectStylesheet — style rules → one annotated stylesheet text.
 *
 * The God Mode CSS panel is a projection of the style-rule registry, never a
 * second store: this renders the rules the caller scoped (assigned classes,
 * matching ambient rules, framework utilities, the node's inline styles) with
 * the SAME emitter the publisher and canvas use, so `@media` folding, custom
 * conditions, `!important` and property sanitisation cannot drift from what a
 * publish ships. Every block is prefixed by an origin/usage comment and its
 * character range is reported so the editor can lock framework blocks.
 */
import { isGeneratedClass, styleRuleSelector } from '@core/page-tree'
import { bagToCSS, createStyleRuleCssEmitter } from '@core/publisher'
import type {
  StylesheetBlockInput,
  StylesheetBlockOrigin,
  StylesheetProjection,
  StylesheetProjectionBlock,
  StylesheetProjectionInput,
} from './types'

/**
 * Selector of the block that projects the selected node's inline styles. It is
 * reserved: a top-level `element { … }` rule in the panel always means "this
 * element's inline styles", never a type selector for an `<element>` tag.
 */
export const ELEMENT_BLOCK_SELECTOR = 'element'

function pluralElements(count: number): string {
  return `${count} element${count === 1 ? '' : 's'}`
}

function blockHeader(origin: StylesheetBlockOrigin, selector: string, usage: number): string {
  switch (origin) {
    case 'class':
      return `/* ${selector} · class · used by ${pluralElements(usage)} */`
    case 'ambient':
      return `/* ${selector} · ambient rule · matches ${pluralElements(usage)} on this page */`
    case 'framework':
      return `/* ${selector} · framework utility · read-only · used by ${pluralElements(usage)} */`
    case 'inline':
      return `/* ${ELEMENT_BLOCK_SELECTOR} · inline styles · this element only */`
  }
}

function ruleOrigin(input: Extract<StylesheetBlockInput, { kind: 'rule' }>): StylesheetBlockOrigin {
  if (isGeneratedClass(input.rule)) return 'framework'
  return input.rule.kind === 'ambient' ? 'ambient' : 'class'
}

function emptyBlock(selector: string): string {
  return `${selector} {\n}`
}

export function projectStylesheet(input: StylesheetProjectionInput): StylesheetProjection {
  const emitRule = createStyleRuleCssEmitter(input.breakpoints, input.conditions)
  const blocks: StylesheetProjectionBlock[] = []
  const parts: string[] = []
  let cursor = 0

  for (const block of input.blocks) {
    let origin: StylesheetBlockOrigin
    let selector: string
    let body: string
    let ruleId: string | null = null
    let nodeId: string | null = null
    let usage = 0

    if (block.kind === 'inline') {
      origin = 'inline'
      selector = ELEMENT_BLOCK_SELECTOR
      nodeId = block.nodeId
      const decls = bagToCSS(block.styles)
      body = decls ? `${selector} {\n${decls}\n}` : emptyBlock(selector)
    } else {
      origin = ruleOrigin(block)
      selector = styleRuleSelector(block.rule)
      ruleId = block.rule.id
      usage = block.usage
      const emitted =
        typeof block.rule.rawCss === 'string'
          ? [block.rule.rawCss.trim()]
          : emitRule(selector, block.rule)
      body = emitted.length > 0 ? emitted.join('\n\n') : emptyBlock(selector)
    }

    const text = `${blockHeader(origin, selector, usage)}\n${body}`
    blocks.push({
      origin,
      ruleId,
      selector,
      from: cursor,
      to: cursor + text.length,
      locked: origin === 'framework',
      nodeId,
    })
    parts.push(text)
    // Blocks are separated by one blank line; the trailing newline keeps the
    // caret below the last block when the user appends a new rule.
    cursor += text.length + 2
  }

  return { text: parts.length > 0 ? `${parts.join('\n\n')}\n` : '', blocks }
}
