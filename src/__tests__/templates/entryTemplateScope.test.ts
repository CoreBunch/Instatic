/**
 * A composed entry template keeps its `template` config, so scoped assets
 * reach the routes they target.
 *
 * `assetScopeAppliesToPage` gates its `templates` branch on
 * `Boolean(page.template)`. `composeTemplateChain` returned a Page built from
 * scratch — id, slug, title, rootNodeId, nodes — which dropped `template`, so
 * a stylesheet scoped to an entry template never applied to that template's
 * own entry routes. The one place it was meant to apply was the one place it
 * could not.
 */
import { describe, expect, it } from 'bun:test'
import { makeSite } from '../fixtures'
import { composeTemplateChain, resolveTemplateChain } from '@core/templates'
import { assetScopeAppliesToPage } from '@core/site-runtime/runtimeConfig'

const postsTarget = { kind: 'postTypes' as const, tableSlugs: ['posts'] }

function siteWithEntryTemplate() {
  const site = makeSite()
  site.pages[0].id = 'post-template'
  site.pages[0].template = { enabled: true, target: postsTarget, priority: 10 }
  return site
}

describe('composed entry template scope', () => {
  it('carries the innermost template config onto the composed page', () => {
    const site = siteWithEntryTemplate()
    const chain = resolveTemplateChain(site, { kind: 'entry', tableSlug: 'posts' })
    const merged = composeTemplateChain(chain, { kind: 'entry' })

    expect(merged.id).toBe('post-template')
    expect(merged.template).toBeDefined()
    expect(merged.template?.enabled).toBe(true)
  })

  it('lets a template-scoped asset match its own entry route', () => {
    const site = siteWithEntryTemplate()
    const chain = resolveTemplateChain(site, { kind: 'entry', tableSlug: 'posts' })
    const merged = composeTemplateChain(chain, { kind: 'entry' })

    const scope = { type: 'templates' as const, templatePageIds: ['post-template'] }
    expect(assetScopeAppliesToPage(scope, merged)).toBe(true)
  })

  it('still excludes a template-scoped asset from an unrelated template', () => {
    const site = siteWithEntryTemplate()
    const chain = resolveTemplateChain(site, { kind: 'entry', tableSlug: 'posts' })
    const merged = composeTemplateChain(chain, { kind: 'entry' })

    const scope = { type: 'templates' as const, templatePageIds: ['some-other-template'] }
    expect(assetScopeAppliesToPage(scope, merged)).toBe(false)
  })

  it('does not invent a template config for a plain page terminal', () => {
    const site = makeSite()
    const page = site.pages[0]
    const merged = composeTemplateChain([], { kind: 'page', page })

    expect(merged.template).toBeUndefined()
  })
})
