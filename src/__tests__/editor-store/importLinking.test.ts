/**
 * Re-import identity (`findReimportedStyleRule`).
 *
 * A rule's import `origin` is provenance, not a unique key: a class rule the
 * Conflicts step renamed (`hero` → `hero-2`) keeps the origin of the rule it
 * came from. The identity a re-import reconciles against is therefore origin
 * AND selector, and the lookup must find the selector-matching rule no matter
 * which of the same-origin rules the registry happens to yield last.
 */

import { describe, it, expect } from 'bun:test'
import type { StyleRule } from '@core/page-tree'
import { cssToStyleRules, type NewStyleRule } from '@core/siteImport'
import { generateClassCSS } from '@core/publisher'
import parse from 'postcss/lib/parse'
import {
  findReimportedStyleRule,
  indexStyleRulesByOrigin,
  registerStyleRuleOrigin,
  mergeImportedStyleRules,
  createStyleRuleOrderAllocator,
} from '@admin/pages/site/store/slices/site/importLinking'

const ORIGIN = { source: 'style.css', ordinal: 2 }

function classRule(id: string, name: string, order: number): StyleRule {
  return {
    id,
    name,
    kind: 'class',
    selector: `.${name}`,
    order,
    styles: { color: 'blue' },
    contextStyles: {},
    origin: { ...ORIGIN },
    createdAt: 1,
    updatedAt: 1,
  }
}

const INCOMING_HERO: NewStyleRule = {
  name: 'hero',
  kind: 'class',
  selector: '.hero',
  order: 0,
  styles: { color: 'red' },
  contextStyles: {},
  origin: { ...ORIGIN },
}

describe('findReimportedStyleRule', () => {
  it('finds the selector-matching rule among several that share one origin, in either registry order', () => {
    const hero = classRule('rule-hero', 'hero', 0)
    const renamed = classRule('rule-hero-2', 'hero-2', 1)

    expect(
      findReimportedStyleRule(
        indexStyleRulesByOrigin({ [hero.id]: hero, [renamed.id]: renamed }),
        INCOMING_HERO,
      )?.id,
    ).toBe('rule-hero')
    expect(
      findReimportedStyleRule(
        indexStyleRulesByOrigin({ [renamed.id]: renamed, [hero.id]: hero }),
        INCOMING_HERO,
      )?.id,
    ).toBe('rule-hero')
  })

  it('does not match a rule with the same origin but a different selector', () => {
    const renamed = classRule('rule-hero-2', 'hero-2', 1)
    expect(
      findReimportedStyleRule(indexStyleRulesByOrigin({ [renamed.id]: renamed }), INCOMING_HERO),
    ).toBeUndefined()
  })

  it('never matches a rule without an origin, whatever its selector', () => {
    const userAuthored: StyleRule = { ...classRule('user-hero', 'hero', 0), origin: undefined }
    delete (userAuthored as { origin?: unknown }).origin
    expect(
      findReimportedStyleRule(
        indexStyleRulesByOrigin({ [userAuthored.id]: userAuthored }),
        INCOMING_HERO,
      ),
    ).toBeUndefined()
    expect(
      findReimportedStyleRule(new Map(), { ...INCOMING_HERO, origin: undefined }),
    ).toBeUndefined()
  })

  it('registering a committed rule makes it findable within the same transaction', () => {
    const byOrigin = indexStyleRulesByOrigin({})
    const committed = classRule('rule-hero', 'hero', 0)
    registerStyleRuleOrigin(byOrigin, committed)
    expect(findReimportedStyleRule(byOrigin, INCOMING_HERO)?.id).toBe('rule-hero')
  })
})

describe('paste stylesheet source fragments', () => {
  it('keeps every layer, ambient/class occurrence and registration with one class binding', () => {
    const parsed = cssToStyleRules(
      '@layer first { body {color:red} .a {color:red} .b {color:blue} .a {color:green} } @layer second { body {color:black} .a {color:orange} } @property --size {syntax:"<length>";inherits:false;initial-value:12px}',
    )
    const registry: Record<string, StyleRule> = {}
    const names = new Map<string, string>()
    mergeImportedStyleRules(parsed.rules, registry, names, createStyleRuleOrderAllocator(registry))
    const css = generateClassCSS(registry, [], parsed.conditions)
    const root = parse(css)
    expect(root.nodes.filter((node) => node.type === 'atrule').map((node) => node.name)).toEqual([
      'layer',
      'layer',
      'property',
    ])
    expect(css.indexOf('color: red')).toBeLessThan(css.indexOf('color: blue'))
    expect(css.indexOf('color: blue')).toBeLessThan(css.indexOf('color: green'))
    expect(css).toContain('color: black')
    expect(css).toContain('color: orange')
    expect(
      Object.values(registry).filter((rule) => rule.kind === 'class' && rule.name === 'a'),
    ).toHaveLength(1)
    expect(registry[names.get('a')!].name).toBe('a')
  })

  it('appends source fragments without rewriting existing shared class identity or order', () => {
    const existing = { ...classRule('shared-a', 'a', 42), origin: undefined }
    const registry: Record<string, StyleRule> = { [existing.id]: existing }
    const names = new Map([['a', existing.id]])
    const parsed = cssToStyleRules('.a {color:red} .b {color:blue} .a {color:green}')
    mergeImportedStyleRules(parsed.rules, registry, names, createStyleRuleOrderAllocator(registry))
    expect(registry[existing.id]).toBe(existing)
    expect(names.get('a')).toBe(existing.id)
    const appended = Object.values(registry).filter((rule) => rule.id !== existing.id)
    expect(appended.map((rule) => rule.order)).toEqual([43, 44, 45])
    expect(appended.filter((rule) => rule.selector === '.a').map((rule) => rule.kind)).toEqual([
      'ambient',
      'ambient',
    ])
    const css = generateClassCSS(registry, [])
    expect(css.indexOf('color: red')).toBeLessThan(
      css.indexOf('color: blue', css.indexOf('color: red')),
    )
    expect(css.indexOf('color: green')).toBeGreaterThan(css.indexOf('color: red'))
  })

  it('gives separately pasted anonymous layer occurrences independent identities', () => {
    const registry: Record<string, StyleRule> = {},
      names = new Map<string, string>()
    const source = cssToStyleRules('@layer { .a {color:red!important} .b {color:blue} }').rules
    mergeImportedStyleRules(source, registry, names, createStyleRuleOrderAllocator(registry))
    mergeImportedStyleRules(source, registry, names, createStyleRuleOrderAllocator(registry))
    const layers = parse(generateClassCSS(registry, [])).nodes
    expect(layers).toHaveLength(2)
    for (const layer of layers) expect(layer.type === 'atrule' && layer.nodes).toHaveLength(2)
    const markers = Object.values(registry).filter((rule) => rule.atRule?.kind === 'group')
    expect(markers[0].atRule?.kind === 'group' && markers[0].atRule.group.id).not.toBe(
      markers[1].atRule?.kind === 'group' && markers[1].atRule.group.id,
    )
  })
})
