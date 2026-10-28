import { describe, it, expect } from 'bun:test'
import { treeShakeStyleRules } from '@core/publisher'
import type { StyleRule } from '@core/page-tree'

const cls = (id: string, name: string): StyleRule =>
  ({
    id,
    name,
    kind: 'class',
    selector: `.${name}`,
    styles: {},
    contextStyles: {},
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as StyleRule

const ambient = (id: string, selector: string): StyleRule =>
  ({
    id,
    name: selector,
    kind: 'ambient',
    selector,
    styles: { float: 'left' },
    contextStyles: {},
    order: 0,
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as StyleRule

// Known and used: header, nav, p1. Known but unused: cart-button, p2, gone.
const rules: Record<string, StyleRule> = {
  header: cls('header', 'header'),
  nav: cls('nav', 'nav'),
  cart: cls('cart', 'cart-button'),
  p1: cls('p1', 'p1'),
  p2: cls('p2', 'p2'),
  gone: cls('gone', 'gone'),
  padding: ambient('padding', '.header .nav > li > a:not(.cart-button)'),
  notList: ambient('notList', '.nav a:not(.gone, .cart-button)'),
  notCompound: ambient('notCompound', '.nav a:not(.gone.p2)'),
  notComplex: ambient('notComplex', '.nav a:not(.gone .p2)'),
  nestedNot: ambient('nestedNot', '.nav:not(:is(.gone, .p2)) a'),
  where: ambient('where', '.header:where(.p1, .p2) .nav'),
  whereDead: ambient('whereDead', '.header:where(.gone, .p2) .nav'),
  is: ambient('is', ':is(.gone, .nav) a'),
  isComplexAlt: ambient('isComplexAlt', ':is(.gone .p1, .header .p1) a'),
  isAllComplexDead: ambient('isAllComplexDead', ':is(.gone .p1, .header .p2) a'),
  isNotInside: ambient('isNotInside', ':is(.nav:not(.gone), .p2) a'),
  isThenDeadOutside: ambient('isThenDeadOutside', ':is(.p1, .nav) .gone'),
  has: ambient('has', '.header:has(.gone)'),
  hasNot: ambient('hasNot', '.header:has(a:not(.gone))'),
  nthOf: ambient('nthOf', '.nav > :nth-child(2n of .gone)'),
  pseudoEl: ambient('pseudoEl', '.nav a:not(.gone)::after'),
  upper: ambient('upper', '.nav a:NOT(.gone)'),
  webkitAny: ambient('webkitAny', ':-webkit-any(.gone, .nav) a'),
  escaped: ambient('escaped', '.hover\\:not-gone:hover .nav'),
  attr: ambient('attr', '.nav a[title=":not(.gone)"]'),
  unbalanced: ambient('unbalanced', '.nav a:not(.gone'),
  bracketParen: ambient('bracketParen', '.nav a:not([x) .gone] .p1'),
  emptyIs: ambient('emptyIs', '.nav:is() a'),
  unknownStillKept: ambient('unknownStillKept', '.nav .not-in-registry'),
  plainDead: ambient('plainDead', '.nav .gone'),
}
const used = new Set(['header', 'nav', 'p1'])
const shaken = treeShakeStyleRules(rules, used)
const kept = (id: string) => shaken[id] !== undefined

describe('treeShakeStyleRules — negation and alternation semantics', () => {
  it('does not treat a negated class as a dependency', () => {
    expect(kept('padding')).toBe(true)
    expect(kept('notList')).toBe(true)
    expect(kept('notCompound')).toBe(true)
    expect(kept('notComplex')).toBe(true)
    expect(kept('nestedNot')).toBe(true)
    expect(kept('pseudoEl')).toBe(true)
    expect(kept('upper')).toBe(true)
    expect(kept('hasNot')).toBe(true)
  })

  it('treats :is()/:where() arguments as alternatives, not a conjunction', () => {
    expect(kept('where')).toBe(true)
    expect(kept('is')).toBe(true)
    expect(kept('isComplexAlt')).toBe(true)
    expect(kept('isNotInside')).toBe(true)
    expect(kept('webkitAny')).toBe(true)
  })

  it('still drops a rule whose every alternative depends on an unused class', () => {
    expect(kept('whereDead')).toBe(false)
    expect(kept('isAllComplexDead')).toBe(false)
  })

  it('still requires classes outside the alternation', () => {
    expect(kept('isThenDeadOutside')).toBe(false)
    expect(kept('plainDead')).toBe(false)
  })

  it('still treats :has() and nth-child(of) arguments as required', () => {
    expect(kept('has')).toBe(false)
    expect(kept('nthOf')).toBe(false)
  })

  it('ignores pseudo-shaped text inside escapes and attribute strings', () => {
    expect(kept('escaped')).toBe(true)
    expect(kept('attr')).toBe(true)
  })

  it('keeps malformed and empty pseudos (conservative)', () => {
    expect(kept('unbalanced')).toBe(true)
    expect(kept('bracketParen')).toBe(true)
    expect(kept('emptyIs')).toBe(true)
    expect(kept('unknownStillKept')).toBe(true)
  })
})
