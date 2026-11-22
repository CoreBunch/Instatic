/**
 * CSS for classes only a module's render output carries.
 *
 * A plugin checkout module writes `commerce-checkout__total` into its own
 * HTML; no node's classIds names it. The site's imported CSS for that markup
 * used to be tree-shaken away at publish. A module now declares the classes it
 * emits (`emittedClassNames`), and the shaker keeps rules matching the
 * declarations of every module placed on the site.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { registry } from '@core/module-engine'
import { collectClassCSS } from '@core/publisher'
import { classKindSelector, type StyleRule } from '@core/page-tree'
import { pluginModuleToHostModule } from '@core/plugins/moduleAdapter'
import type { PluginModuleDefinition } from '@core/plugin-sdk'
import { makeNode, makePage, makeSite, makeVC, makeVCNode, makeVCTree } from '../fixtures'

function classRule(name: string, color: string): StyleRule {
  return {
    id: `rule-${name}`,
    name,
    kind: 'class',
    selector: classKindSelector(name),
    order: 0,
    styles: { color },
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

const STYLE_RULES = {
  'rule-commerce-checkout': classRule('commerce-checkout', 'red'),
  'rule-commerce-checkout__total': classRule('commerce-checkout__total', 'blue'),
  'rule-commerce-badge': classRule('commerce-badge', 'green'),
  'rule-unrelated': classRule('unrelated', 'black'),
}

function registerCheckout(emittedClassNames?: unknown): void {
  const definition = {
    id: 'acme.checkout',
    name: 'Checkout',
    category: 'Commerce',
    version: '1.0.0',
    defaults: {},
    schema: {},
    render: () => ({ html: '<div class="commerce-checkout"><p class="commerce-checkout__total">0</p></div>' }),
    ...(emittedClassNames !== undefined ? { emittedClassNames } : {}),
  } as PluginModuleDefinition
  registry.registerOrReplace(pluginModuleToHostModule('acme', definition, () => () => null, []))
}

function siteWithCheckoutOnPage() {
  const root = makeNode({ id: 'root', moduleId: 'base.body', children: ['checkout'] })
  const checkout = makeNode({ id: 'checkout', moduleId: 'acme.checkout' })
  return makeSite({ pages: [makePage({ nodes: { root, checkout } })], styleRules: STYLE_RULES })
}

afterEach(() => {
  if (registry.has('acme.checkout')) registry.unregister('acme.checkout')
})

describe('module-emitted class CSS', () => {
  it('keeps rules for classes a placed module declares, exactly or by prefix', () => {
    registerCheckout(['commerce-checkout*', 'commerce-badge'])
    const css = collectClassCSS(siteWithCheckoutOnPage(), registry)
    expect(css).toContain('.commerce-checkout {')
    expect(css).toContain('.commerce-checkout__total {')
    expect(css).toContain('.commerce-badge {')
    expect(css).not.toContain('.unrelated')
  })

  it('drops them when the module declares nothing (the behaviour before the fix)', () => {
    registerCheckout()
    expect(collectClassCSS(siteWithCheckoutOnPage(), registry)).toBe('')
  })

  it('ignores a declaring module that is registered but not placed on the site', () => {
    registerCheckout(['commerce-checkout*'])
    const site = makeSite({ styleRules: STYLE_RULES })
    expect(collectClassCSS(site, registry)).toBe('')
  })

  it('counts a module placed inside a Visual Component', () => {
    registerCheckout(['commerce-checkout'])
    const vc = makeVC({
      id: 'vc-1',
      name: 'Cart',
      tree: makeVCTree('vc-root', [
        makeVCNode({ id: 'vc-root', children: ['inner'] }),
        makeVCNode({ id: 'inner', moduleId: 'acme.checkout' }),
      ]),
    })
    const css = collectClassCSS(makeSite({ styleRules: STYLE_RULES, visualComponents: [vc] }), registry)
    expect(css).toContain('.commerce-checkout {')
    expect(css).not.toContain('.commerce-checkout__total')
  })

  it('drops malformed declarations instead of keeping every rule, and says so once', () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    try {
      registerCheckout(['*', '.dotted', 'not a class', 42, Object.create(null), 'commerce-badge'])
    } finally {
      console.warn = originalWarn
    }
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toStartWith('[plugin:acme] module "acme.checkout" emittedClassNames: ignored 5 entries')
    expect(registry.get('acme.checkout')?.emittedClassNames).toEqual(['commerce-badge'])
    const css = collectClassCSS(siteWithCheckoutOnPage(), registry)
    expect(css).toContain('.commerce-badge {')
    expect(css).not.toContain('.commerce-checkout')
  })
})
