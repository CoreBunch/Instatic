import { describe, expect, it } from 'bun:test'
import '@modules/base'
import { registry } from '@core/module-engine'
import { publishPage } from '@core/publisher'
import { buildSiteModuleJsMap, injectModuleScripts } from '../../../server/publish/moduleJsBundle'
import { DISCLOSURE_RUNTIME_JS } from '@modules/base/disclosure/disclosureRuntimeJs'
import { makePage, makeSite } from './helpers'

describe('native disclosure module assets', () => {
  it('publishes multiple instances with one external asset and only same-origin CSP', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['a', 'b'] },
      a: { moduleId: 'base.disclosure', props: { label: 'First', group: 'navigation' }, children: ['link'] },
      b: { moduleId: 'base.disclosure', props: { label: 'Second', group: 'navigation' } },
      link: { moduleId: 'base.link', props: { text: 'Products', href: '/products' } },
    })
    const site = makeSite({ pages: [page] })
    const result = publishPage(page, site, registry)
    expect(result.jsModuleIds).toEqual(['base.disclosure'])
    expect(buildSiteModuleJsMap(site, registry).get('base.disclosure')).toBe(DISCLOSURE_RUNTIME_JS)
    const html = injectModuleScripts(result.html, result.jsModuleIds, 42)
    expect(html.match(/data-instatic-module-js="base.disclosure"/g)).toHaveLength(1)
    expect(html).toContain('src="/_instatic/module-js/base.disclosure.js?v=42"')
    expect(html).toContain("script-src 'self'")
    expect(html.match(/script-src[^;]+/)?.[0]).toBe("script-src 'self'")
    expect(html).toContain('<summary>First</summary>')
    expect(html).toContain('href="/products"')
  })

  it('a page without a disclosure has no disclosure asset', () => {
    const page = makePage({ root: { moduleId: 'base.body' } })
    const site = makeSite({ pages: [page] })
    const result = publishPage(page, site, registry)
    expect(result.jsModuleIds).toEqual([])
    expect(buildSiteModuleJsMap(site, registry).has('base.disclosure')).toBe(false)
  })
})
