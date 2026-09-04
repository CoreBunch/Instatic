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
import type { NewStyleRule } from '@core/siteImport'
import {
  findReimportedStyleRule,
  indexStyleRulesByOrigin,
  registerStyleRuleOrigin,
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

    expect(findReimportedStyleRule(indexStyleRulesByOrigin({ [hero.id]: hero, [renamed.id]: renamed }), INCOMING_HERO)?.id)
      .toBe('rule-hero')
    expect(findReimportedStyleRule(indexStyleRulesByOrigin({ [renamed.id]: renamed, [hero.id]: hero }), INCOMING_HERO)?.id)
      .toBe('rule-hero')
  })

  it('does not match a rule with the same origin but a different selector', () => {
    const renamed = classRule('rule-hero-2', 'hero-2', 1)
    expect(findReimportedStyleRule(indexStyleRulesByOrigin({ [renamed.id]: renamed }), INCOMING_HERO)).toBeUndefined()
  })

  it('never matches a rule without an origin, whatever its selector', () => {
    const userAuthored: StyleRule = { ...classRule('user-hero', 'hero', 0), origin: undefined }
    delete (userAuthored as { origin?: unknown }).origin
    expect(findReimportedStyleRule(indexStyleRulesByOrigin({ [userAuthored.id]: userAuthored }), INCOMING_HERO)).toBeUndefined()
    expect(findReimportedStyleRule(new Map(), { ...INCOMING_HERO, origin: undefined })).toBeUndefined()
  })

  it('registering a committed rule makes it findable within the same transaction', () => {
    const byOrigin = indexStyleRulesByOrigin({})
    const committed = classRule('rule-hero', 'hero', 0)
    registerStyleRuleOrigin(byOrigin, committed)
    expect(findReimportedStyleRule(byOrigin, INCOMING_HERO)?.id).toBe('rule-hero')
  })
})
