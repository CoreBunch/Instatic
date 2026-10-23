/**
 * styleRuleTreeShake — which registry rules survive into published CSS.
 *
 * The regression this file guards: a state class toggled at runtime by a
 * script (`overlay.classList.add('is-open')`) is invisible to the shaker,
 * because the shaker keys `kind:'class'` rules on `usedIds.has(rule.id)` and
 * no node ever carries that id. Authoring `.drawer.is-open` must therefore
 * classify as ambient so it survives on its class dependencies instead.
 */

import { describe, it, expect } from 'bun:test'
import { treeShakeStyleRules } from '@core/publisher'
import { selectorBindingClassName, type StyleRule } from '@core/page-tree'

function rule(partial: Partial<StyleRule> & Pick<StyleRule, 'id' | 'selector'>): StyleRule {
  const bindingName = selectorBindingClassName(partial.selector)
  return {
    name: bindingName ?? partial.selector,
    kind: bindingName ? 'class' : 'ambient',
    order: 0,
    styles: {},
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  }
}

describe('treeShakeStyleRules — runtime state classes', () => {
  it('keeps a runtime-toggled state rule whose base class is used', () => {
    const drawer = rule({ id: 'drawer', selector: '.drawer' })
    const open = rule({ id: 'open', selector: '.drawer.is-open' })
    const panel = rule({ id: 'panel', selector: '.drawer.is-open .drawer-panel' })

    // Sanity: the state rule must be ambient, or the id gate below drops it.
    expect(open.kind).toBe('ambient')

    const kept = treeShakeStyleRules(
      { drawer, open, panel },
      new Set(['drawer', 'panel']),
    )

    expect(Object.keys(kept).sort()).toEqual(['drawer', 'open', 'panel'])
  })

  it('still drops an unused class rule', () => {
    const used = rule({ id: 'used', selector: '.used' })
    const unused = rule({ id: 'unused', selector: '.unused' })

    const kept = treeShakeStyleRules({ used, unused }, new Set(['used']))

    expect(Object.keys(kept)).toEqual(['used'])
  })

  it('still drops an ambient rule that depends on a known but unused class', () => {
    const card = rule({ id: 'card', selector: '.card' })
    const badge = rule({ id: 'badge', selector: '.badge' })
    const nested = rule({ id: 'nested', selector: '.card .badge' })

    const kept = treeShakeStyleRules({ card, badge, nested }, new Set(['card']))

    expect(Object.keys(kept)).toEqual(['card'])
  })

  it('keeps a Tailwind-style variant bound to its rightmost subject class', () => {
    const group = rule({ id: 'group', selector: '.group' })
    const variant = rule({
      id: 'variant',
      selector: '.group:hover .group-hover\\:block',
    })

    expect(variant.kind).toBe('class')
    expect(variant.name).toBe('group-hover:block')

    // Assigned to a node → kept.
    expect(
      Object.keys(treeShakeStyleRules({ group, variant }, new Set(['group', 'variant']))).sort(),
    ).toEqual(['group', 'variant'])

    // Not assigned to any node → still tree-shaken, so large utility
    // registries do not leak unused variants into published CSS.
    expect(
      Object.keys(treeShakeStyleRules({ group, variant }, new Set(['group']))),
    ).toEqual(['group'])
  })
})
