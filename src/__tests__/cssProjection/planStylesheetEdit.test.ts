/**
 * planStylesheetEdit — the God Mode CSS panel's write side: edited stylesheet
 * text + the projection it was derived from → a registry edit plan.
 */
import { describe, it, expect } from 'bun:test'
import type { StyleRule } from '@core/page-tree'
import { planStylesheetEdit, projectStylesheet } from '@core/cssProjection'

const BREAKPOINTS = [{ id: 'tablet', width: 768, mediaQuery: '(max-width: 768px)' }]

function rule(overrides: Partial<StyleRule> & Pick<StyleRule, 'id' | 'name' | 'selector' | 'kind'>): StyleRule {
  return { order: 0, styles: {}, contextStyles: {}, createdAt: 1, updatedAt: 1, ...overrides }
}

const card = rule({ id: 'r1', name: 'card', kind: 'class', selector: '.card', styles: { color: 'red' } })
const heading = rule({ id: 'a1', name: 'h1', kind: 'ambient', selector: 'h1', styles: { fontWeight: '700' } })
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

function projectionOf(inline: Record<string, unknown> | null = { marginTop: '4px' }) {
  return projectStylesheet({
    blocks: [
      { kind: 'rule', rule: card, usage: 2 },
      { kind: 'rule', rule: heading, usage: 1 },
      { kind: 'rule', rule: utility, usage: 5 },
      ...(inline ? [{ kind: 'inline' as const, nodeId: 'n1', styles: inline }] : []),
    ],
    breakpoints: BREAKPOINTS,
    conditions: [],
  })
}

describe('planStylesheetEdit', () => {
  it('re-applying the projection unchanged plans a no-op-shaped edit', () => {
    const projection = projectionOf()
    const plan = planStylesheetEdit({ text: projection.text, projection, breakpoints: BREAKPOINTS })

    expect(plan.blockedSelectors).toEqual([])
    expect(plan.edit.clearedClassIds).toEqual([])
    expect(plan.edit.deletedAmbientIds).toEqual([])
    expect(plan.edit.rules.map((r) => r.selector)).toEqual(['.card', 'h1'])
    expect(plan.edit.rules[0].styles).toEqual({ color: 'red' })
    expect(plan.edit.inlineStyles).toEqual({ nodeId: 'n1', styles: { marginTop: '4px' } })
  })

  it('folds a matching @media block into the breakpoint context of the edited rule', () => {
    const projection = projectionOf()
    const text = projection.text.replace(
      '.card {\n  color: red;\n}',
      '.card {\n  color: green;\n}\n@media (max-width: 768px) {\n  .card {\n    color: blue;\n  }\n}',
    )
    const plan = planStylesheetEdit({ text, projection, breakpoints: BREAKPOINTS })
    const edited = plan.edit.rules.find((r) => r.selector === '.card')!
    expect(edited.styles).toEqual({ color: 'green' })
    expect(edited.contextStyles).toEqual({ tablet: { color: 'blue' } })
  })

  it('treats a removed class block as cleared and a removed ambient block as deleted', () => {
    const projection = projectionOf()
    const text = projection.text
      .replace(/\/\* \.card[^\n]*\n\.card \{\n {2}color: red;\n\}\n\n/, '')
      .replace(/\/\* h1[^\n]*\nh1 \{\n {2}font-weight: 700;\n\}\n\n/, '')
    const plan = planStylesheetEdit({ text, projection, breakpoints: BREAKPOINTS })
    expect(plan.edit.clearedClassIds).toEqual(['r1'])
    expect(plan.edit.deletedAmbientIds).toEqual(['a1'])
    expect(plan.edit.rules.map((r) => r.selector)).toEqual([])
  })

  it('keeps an emptied block as an empty rule rather than a deletion', () => {
    const projection = projectionOf()
    const text = projection.text.replace('h1 {\n  font-weight: 700;\n}', 'h1 {\n}')
    const plan = planStylesheetEdit({ text, projection, breakpoints: BREAKPOINTS })
    expect(plan.edit.deletedAmbientIds).toEqual([])
    expect(plan.edit.rules.find((r) => r.selector === 'h1')!.styles).toEqual({})
  })

  it('routes the element block to inline styles and drops its @media with a warning', () => {
    const projection = projectionOf()
    const text = projection.text.replace(
      'element {\n  margin-top: 4px;\n}',
      'element {\n  margin-top: 8px;\n}\n@media (max-width: 768px) {\n  element {\n    margin-top: 0;\n  }\n}',
    )
    const plan = planStylesheetEdit({ text, projection, breakpoints: BREAKPOINTS })
    expect(plan.edit.inlineStyles).toEqual({ nodeId: 'n1', styles: { marginTop: '8px' } })
    expect(plan.edit.rules.some((r) => r.selector === 'element')).toBe(false)
    expect(plan.warnings.some((w) => /inline styles/i.test(w))).toBe(true)
  })

  it('clears inline styles when the element block is removed, and never invents one', () => {
    const projection = projectionOf()
    const removed = projection.text.replace(/\/\* element[^\n]*\nelement \{\n {2}margin-top: 4px;\n\}\n?/, '')
    expect(planStylesheetEdit({ text: removed, projection, breakpoints: BREAKPOINTS }).edit.inlineStyles)
      .toEqual({ nodeId: 'n1', styles: {} })

    const pageScoped = projectionOf(null)
    const plan = planStylesheetEdit({
      text: `${pageScoped.text}\nelement { color: red }\n`,
      projection: pageScoped,
      breakpoints: BREAKPOINTS,
    })
    expect(plan.edit.inlineStyles).toBeNull()
    expect(plan.edit.rules.some((r) => r.selector === 'element')).toBe(false)
    expect(plan.warnings.some((w) => /no element is selected/i.test(w))).toBe(true)
  })

  it('reports edits to framework utilities as blocked instead of applying them', () => {
    const projection = projectionOf()
    const text = projection.text.replace('font-size: var(--text-m);', 'font-size: 99px;')
    const plan = planStylesheetEdit({ text, projection, breakpoints: BREAKPOINTS })
    expect(plan.blockedSelectors).toEqual(['.text-m'])
    expect(plan.edit.rules.some((r) => r.selector === '.text-m')).toBe(false)
  })

  it('lets a new selector through as a new rule (assignment stays explicit)', () => {
    const projection = projectionOf()
    const text = `${projection.text}\n.brand-new {\n  color: hotpink;\n}\n\nnav a:hover {\n  color: red;\n}\n`
    const plan = planStylesheetEdit({ text, projection, breakpoints: BREAKPOINTS })
    const created = plan.edit.rules.filter((r) => r.selector === '.brand-new' || r.selector === 'nav a:hover')
    expect(created.map((r) => [r.kind, r.selector])).toEqual([
      ['class', '.brand-new'],
      ['ambient', 'nav a:hover'],
    ])
  })
})
