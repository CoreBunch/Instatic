import { describe, expect, it } from 'bun:test'
import { GlobalWindow } from 'happy-dom'
import { cssToStyleRules } from '@core/siteImport'
import { generateClassCSS, treeShakeStyleRules } from '@core/publisher'
import type { StyleRule } from '@core/page-tree'

function convertedCss(css: string): string {
  const parsed = cssToStyleRules(css, { breakpoints: [], mediaTolerance: 0 })
  const rules: Record<string, StyleRule> = Object.fromEntries(
    parsed.rules.map((rule, index) => {
      const id = String(index)
      return [id, { ...rule, id, createdAt: 0, updatedAt: 0 }]
    }),
  )
  const ids = new Set(
    Object.values(rules)
      .filter((rule) => rule.kind === 'class')
      .map((rule) => rule.id),
  )
  return generateClassCSS(treeShakeStyleRules(rules, ids), [], parsed.conditions)
}

function computedColor(css: string): string {
  const window = new GlobalWindow()
  const style = window.document.createElement('style')
  style.textContent = css
  window.document.head.append(style)
  const element = window.document.createElement('div')
  element.className = 'a b'
  window.document.body.append(element)
  return window.getComputedStyle(element).color
}

describe('CSS import through the publisher preserves source-order cascade', () => {
  for (const [name, css, expected] of [
    [
      'a repeated base selector after a competing class',
      '.a { color: red } .b { color: blue } .a { color: green }',
      'green',
    ],
    [
      'a late conditional selector after a competing class',
      '.a { color: red } .b { color: blue } @media (min-width: 1px) { .a { color: green } }',
      'green',
    ],
    [
      'a late base selector after an early conditional selector',
      '@media (min-width: 1px) { .a { color: green } } .a { color: red }',
      'red',
    ],
    [
      'an early important declaration against a later normal fragment',
      '.a { color: red !important } .b { color: blue } .a { color: green }',
      'red',
    ],
  ]) {
    it(name, () => {
      const original = computedColor(css)
      expect(original).toBe(expected)
      expect(computedColor(convertedCss(css))).toBe(original)
    })
  }

  it('preserves every condition in a nested conditional subtree', () => {
    const { rules, warnings, conditions } = cssToStyleRules(
      '@media (min-width: 1px) { @supports (display: grid) { .a { color: green } } }',
    )
    expect(rules).toHaveLength(1)
    expect(warnings).toHaveLength(0)
    expect(
      rules[0].grouping?.map((group) => (group.kind === 'context' ? group.contextId : null)),
    ).toEqual(conditions.map((condition) => condition.id))
    const css = convertedCss(
      '@media (min-width: 1px) { @supports (display: grid) { .a { color: green } } }',
    )
    expect(css.indexOf('@media')).toBeLessThan(css.indexOf('@supports'))
    expect(css).toContain('color: green')
  })
})
