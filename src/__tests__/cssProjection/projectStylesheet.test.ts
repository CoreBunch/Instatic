/**
 * projectStylesheet — the God Mode CSS panel's read side: style rules (and a
 * node's inline styles) → one annotated stylesheet text with block ranges.
 */
import { describe, it, expect } from 'bun:test'
import type { StyleRule } from '@core/page-tree'
import { projectStylesheet, ELEMENT_BLOCK_SELECTOR } from '@core/cssProjection'

const BREAKPOINTS = [
  { id: 'tablet', width: 768, mediaQuery: '(max-width: 768px)' },
]

function rule(overrides: Partial<StyleRule> & Pick<StyleRule, 'id' | 'name' | 'selector' | 'kind'>): StyleRule {
  return {
    order: 0,
    styles: {},
    contextStyles: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('projectStylesheet', () => {
  it('emits an annotated class block with its @media overrides folded in', () => {
    const card = rule({
      id: 'r1',
      name: 'card',
      kind: 'class',
      selector: '.card',
      styles: { color: 'red' },
      contextStyles: { tablet: { color: 'blue' } },
    })
    const projection = projectStylesheet({
      blocks: [{ kind: 'rule', rule: card, usage: 3 }],
      breakpoints: BREAKPOINTS,
      conditions: [],
    })

    expect(projection.text).toBe(
      [
        '/* .card · class · used by 3 elements */',
        '.card {',
        '  color: red;',
        '}',
        '',
        '@media (max-width: 768px) {',
        '  .card {',
        '  color: blue;',
        '  }',
        '}',
        '',
      ].join('\n'),
    )
    expect(projection.blocks).toHaveLength(1)
    const block = projection.blocks[0]
    expect(block).toMatchObject({ origin: 'class', ruleId: 'r1', selector: '.card', locked: false })
    expect(projection.text.slice(block.from, block.to)).toStartWith('/* .card')
    expect(projection.text.slice(block.from, block.to)).toEndWith('}')
  })

  it('emits an empty declaration block for a rule with no styles so it can be edited', () => {
    const empty = rule({ id: 'r2', name: 'hero', kind: 'class', selector: '.hero' })
    const projection = projectStylesheet({
      blocks: [{ kind: 'rule', rule: empty, usage: 1 }],
      breakpoints: [],
      conditions: [],
    })
    expect(projection.text).toContain('.hero {\n}')
  })

  it('labels ambient rules by page matches and framework rules as read-only', () => {
    const heading = rule({
      id: 'a1',
      name: 'h1',
      kind: 'ambient',
      selector: 'h1',
      styles: { fontWeight: '700' },
    })
    const utility = rule({
      id: 'g1',
      name: 'text-m',
      kind: 'class',
      selector: '.text-m',
      styles: { fontSize: 'var(--text-m)' },
      generated: {
        origin: 'framework',
        family: 'typography',
        sourceId: 'body',
        generatorId: 'gen',
        tokenName: 'text',
        step: 'm',
        locked: true,
      },
    })
    const projection = projectStylesheet({
      blocks: [
        { kind: 'rule', rule: heading, usage: 1 },
        { kind: 'rule', rule: utility, usage: 12 },
      ],
      breakpoints: [],
      conditions: [],
    })

    expect(projection.text).toContain('/* h1 · ambient rule · matches 1 element on this page */')
    expect(projection.text).toContain('/* .text-m · framework utility · read-only · used by 12 elements */')
    expect(projection.blocks.map((b) => [b.origin, b.locked])).toEqual([
      ['ambient', false],
      ['framework', true],
    ])
    // Blocks are separated by exactly one blank line and ranges never overlap.
    const [first, second] = projection.blocks
    expect(projection.text.slice(first.to, second.from)).toBe('\n\n')
  })

  it("renders a node's inline styles as the reserved `element` block", () => {
    const projection = projectStylesheet({
      blocks: [{ kind: 'inline', nodeId: 'n1', styles: { marginTop: '4px' } }],
      breakpoints: [],
      conditions: [],
    })
    expect(projection.text).toBe(
      [
        '/* element · inline styles · this element only */',
        `${ELEMENT_BLOCK_SELECTOR} {`,
        '  margin-top: 4px;',
        '}',
        '',
      ].join('\n'),
    )
    expect(projection.blocks[0]).toMatchObject({
      origin: 'inline',
      ruleId: null,
      selector: ELEMENT_BLOCK_SELECTOR,
      locked: false,
    })
  })

  it('projects nothing but an empty string for no blocks', () => {
    const projection = projectStylesheet({ blocks: [], breakpoints: [], conditions: [] })
    expect(projection.text).toBe('')
    expect(projection.blocks).toEqual([])
  })
})
