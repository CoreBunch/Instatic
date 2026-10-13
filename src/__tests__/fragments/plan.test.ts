/**
 * planFragmentInsert — every merge rule, against a populated and an empty site.
 */

import { describe, expect, it } from 'bun:test'
import {
  FRAGMENT_PROPERTIES_ORIGIN,
  FragmentInsertError,
  extractFragment,
  fragmentSourceFromSite,
  planFragmentInsert,
  type FragmentInsertPlan,
  type SiteFragment,
} from '@core/fragments'
import { generateFrameworkUtilityClasses } from '@core/framework'
import type { PageNode } from '@core/page-tree'
import { makeNode, makePage, makeSite } from '../fixtures'
import {
  SOURCE_ROWS,
  SOURCE_TABLES,
  TARGET_TABLES,
  makeSourceSite,
  makeTargetSite,
  sourceMediaWithBytes,
} from './fixtures'

async function sectionFragment(): Promise<SiteFragment> {
  const source = fragmentSourceFromSite(makeSourceSite(), {
    tables: SOURCE_TABLES,
    rows: SOURCE_ROWS,
    media: sourceMediaWithBytes(),
  })
  return (await extractFragment(source, { pageId: 'page-home', rootNodeIds: ['hero'] })).fragment
}

async function planIntoTarget(): Promise<{ plan: FragmentInsertPlan; target: ReturnType<typeof makeTargetSite> }> {
  const target = makeTargetSite()
  const plan = planFragmentInsert(
    { site: target, tables: TARGET_TABLES, document: { kind: 'page', pageId: 't-home' } },
    await sectionFragment(),
  )
  return { plan, target }
}

function nodeByModule(plan: FragmentInsertPlan, moduleId: string): PageNode {
  const node = Object.values(plan.nodes).find((n) => n.moduleId === moduleId)
  if (!node) throw new Error(`no ${moduleId}`)
  return node
}

describe('planFragmentInsert — classes and rules', () => {
  it('mints fresh node ids for everything', async () => {
    const { plan } = await planIntoTarget()
    const fragment = await sectionFragment()
    for (const id of Object.keys(plan.nodes)) expect(fragment.nodes[id]).toBeUndefined()
    expect(plan.roots).toHaveLength(1)
    expect(plan.nodes[plan.roots[0]].parentId).toBeNull()
  })

  it("reuses the site's class of the same name, even when its styles differ", async () => {
    const { plan, target } = await planIntoTarget()
    const hero = plan.nodes[plan.roots[0]]
    expect(hero.classIds).toContain('t-hero')
    expect(plan.styleRules.find((r) => r.name === 'hero')).toBeUndefined()
    expect(target.styleRules['t-hero'].styles).toEqual({ paddingTop: '99px' })
    expect(plan.report.rules.reused).toContain('hero')
  })

  it('adds missing classes after the existing cascade, in the fragment order', async () => {
    const { plan, target } = await planIntoTarget()
    const maxExisting = Math.max(...Object.values(target.styleRules).map((r) => r.order))
    const added = plan.styleRules
    for (const rule of added) {
      expect(rule.order).toBeGreaterThan(maxExisting)
      expect(target.styleRules[rule.id]).toBeUndefined()
    }
    const names = added.map((r) => r.name)
    expect(names.indexOf('hero-title')).toBeLessThan(names.indexOf('@keyframes fade'))
    const orders = added.map((r) => r.order)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
    // `card` belongs to the fragment's Card, and the site's Card wins.
    expect(plan.report.rules.added).toEqual(['hero-title'])
  })

  it('keeps an ambient rule whose selector the site has, adds the others', async () => {
    const { plan } = await planIntoTarget()
    expect(plan.report.rules.ambientKept).toEqual(['.hero .hero-title:hover'])
    expect(plan.report.rules.ambientAdded).toEqual(['.page-wrap .hero-title', '@keyframes fade'])
  })

  it('clones scoped module-style rules onto the new node ids', async () => {
    const { plan } = await planIntoTarget()
    const scoped = plan.styleRules.find((r) => r.scope)
    const hero = plan.nodes[plan.roots[0]]
    expect(scoped?.scope?.nodeId).toBe(hero.id)
    expect(hero.classIds).toContain(scoped!.id)
  })

  it('matches framework utilities by name after the token merge', async () => {
    const { plan, target } = await planIntoTarget()
    const title = nodeByModule(plan, 'base.text')
    // text-xl exists only because the insert adds the xl step to the site's scale.
    const after = generateFrameworkUtilityClasses({
      ...target.settings.framework!,
      typography: {
        ...target.settings.framework!.typography!,
        groups: [{ ...target.settings.framework!.typography!.groups[0], steps: 'xs,s,m,l,xl' }],
      },
    })
    const textXl = Object.values(after).find((c) => c.name === 'text-xl')!
    const textPrimary = Object.values(after).find((c) => c.name === 'text-primary')!
    expect(title.classIds).toContain(textXl.id)
    expect(title.classIds).toContain(textPrimary.id)
  })
})

describe('planFragmentInsert — tokens', () => {
  it('adds a missing colour with its full definition and keeps the existing one', async () => {
    const { plan } = await planIntoTarget()
    expect(plan.report.colors).toEqual({ added: ['accent'], kept: ['primary'] })
    const accent = plan.colorTokens[0]
    expect(accent.slug).toBe('accent')
    expect(accent.lightValue).toBe('#ff8800')
    expect(accent.generateTransparent).toBe(true)
    expect(accent.generateUtilities).toEqual({ text: true, background: true, border: false, fill: false })
    expect(accent.id).not.toBe('col-accent')
  })

  it("warns about colour variants the site's colour does not generate", async () => {
    const { plan } = await planIntoTarget()
    const subjects = plan.report.warnings.filter((w) => w.code === 'color-variant-missing').map((w) => w.subject)
    expect(subjects).toEqual(['--primary-d-2'])
  })

  it("inserts missing steps into the site's own scale and keeps its base step", async () => {
    const { plan } = await planIntoTarget()
    const typography = plan.scaleSteps.find((s) => s.family === 'typography')
    const spacing = plan.scaleSteps.find((s) => s.family === 'spacing')
    expect(typography).toEqual({ family: 'typography', groupId: 't-type', steps: 'xs,s,m,l,xl', baseScaleIndex: 2 })
    // `s` lands before the base step `m`, so the base index moves with it.
    expect(spacing).toEqual({ family: 'spacing', groupId: 't-space', steps: 's,m,l', baseScaleIndex: 1 })
  })

  it('adds the missing font token with its family', async () => {
    const { plan } = await planIntoTarget()
    expect(plan.report.fonts.tokensAdded).toEqual(['font-heading'])
    expect(plan.fontFamilies.map((f) => f.entry.family)).toEqual(['Inter'])
    // Bound to the family being installed until the commit knows its real id.
    expect(plan.fontTokens[0].familyId).toBe(plan.fontFamilies[0].fragmentFamilyId)
  })

  it('puts root custom properties the site lacks into one engine-owned :root rule', async () => {
    const { plan } = await planIntoTarget()
    expect(plan.report.customProperties).toEqual({ added: ['--shadow'], kept: ['--radius'] })
    expect(plan.customProperties?.create).toBe(true)
    expect(plan.customProperties?.properties).toEqual({ '--shadow': '0 0 4px var(--primary-50)' })
  })

  it('reuses the engine-owned :root rule on a second insert', async () => {
    const target = makeTargetSite()
    target.styleRules['owned'] = {
      id: 'owned', name: ':root', kind: 'ambient', selector: ':root', order: 50,
      styles: { '--other': '1' }, contextStyles: {},
      origin: { source: FRAGMENT_PROPERTIES_ORIGIN, ordinal: 0 },
      createdAt: 1, updatedAt: 1,
    }
    const plan = planFragmentInsert(
      { site: target, tables: TARGET_TABLES, document: { kind: 'page', pageId: 't-home' } },
      await sectionFragment(),
    )
    expect(plan.customProperties).toEqual({ ruleId: 'owned', create: false, order: 50, properties: { '--shadow': '0 0 4px var(--primary-50)' } })
  })
})

describe('planFragmentInsert — components, tables, links, media', () => {
  it("points instances at the site's component of the same name and skips its nested ones", async () => {
    const { plan } = await planIntoTarget()
    expect(nodeByModule(plan, 'base.visual-component-ref').props.componentId).toBe('t-vc-card')
    expect(plan.report.components).toEqual({ added: [], reused: ['Card'] })
    expect(plan.components).toEqual([])
  })

  it('adds components the site lacks, nested ones included, with fresh ids', async () => {
    const target = makeTargetSite()
    target.visualComponents = []
    const plan = planFragmentInsert(
      { site: target, tables: TARGET_TABLES, document: { kind: 'page', pageId: 't-home' } },
      await sectionFragment(),
    )
    expect(plan.components.map((c) => c.name).sort()).toEqual(['Badge', 'Card'])
    const card = plan.components.find((c) => c.name === 'Card')!
    const badge = plan.components.find((c) => c.name === 'Badge')!
    expect(card.id).not.toBe('vc-card')
    const nested = Object.values(card.tree.nodes).find((n) => n.moduleId === 'base.visual-component-ref')!
    expect(nested.props.componentId).toBe(badge.id)
    expect(nodeByModule(plan, 'base.visual-component-ref').props.componentId).toBe(card.id)
    const cardRoot = card.tree.nodes[card.tree.rootNodeId]
    expect(plan.styleRules.find((r) => r.id === cardRoot.classIds[0])?.name).toBe('card')
  })

  it('reuses a table by slug, adds its missing fields, creates the missing one', async () => {
    const { plan } = await planIntoTarget()
    expect(plan.report.tables).toEqual({ created: ['contact'], reused: ['projects'], fieldsAdded: ['projects.cover'], rows: 0 })
    const reuse = plan.tables.find((t) => t.action === 'reuse')!
    expect(reuse.action === 'reuse' && reuse.addFields.map((f) => f.id)).toEqual(['cover'])
    expect(plan.report.warnings.some((w) => w.code === 'relation-field-dropped' && w.subject === 'projects.owner')).toBe(true)
    const loop = nodeByModule(plan, 'base.loop')
    expect((loop.props.filters as Record<string, unknown>).tableId).toBe('t-tbl-projects')
    // The created table's id comes from the server at commit time.
    expect(nodeByModule(plan, 'base.form').props.targetTableId).toBe('tbl-contact')
  })

  it('remaps a link to a page the site has by slug, and turns the rest into #', async () => {
    const { plan } = await planIntoTarget()
    expect(nodeByModule(plan, 'base.link').props.href).toBe('cms:page:t-about#team')
    expect(plan.report.links).toEqual({ remapped: ['about'], unresolved: [] })

    const target = makeTargetSite()
    target.pages = target.pages.filter((p) => p.slug !== 'about')
    const plan2 = planFragmentInsert(
      { site: target, tables: TARGET_TABLES, document: { kind: 'page', pageId: 't-home' } },
      await sectionFragment(),
    )
    expect(nodeByModule(plan2, 'base.link').props.href).toBe('#')
    expect(plan2.report.links.unresolved).toEqual(['about'])
  })

  it('plans only the media the inserted content uses', async () => {
    const { plan } = await planIntoTarget()
    // cover.jpg is only used by rows of the reused projects table, which are
    // not added; bg.jpg only by the fragment's `hero`, and the site's wins.
    expect(plan.media.map((m) => m.id).sort()).toEqual(['media-font', 'media-photo'])
  })

  it('repeats the outside dependencies the extractor found', async () => {
    const { plan } = await planIntoTarget()
    expect(plan.report.outsideDependencies).toEqual([{ selector: '.page-wrap .hero-title', classes: ['page-wrap'] }])
  })
})

describe('planFragmentInsert — empty site, pages and guards', () => {
  it('into an empty site: everything is added', async () => {
    const empty = makeSite({ pages: [makePage({ id: 'e-home' })] })
    const plan = planFragmentInsert(
      { site: empty, tables: [], document: { kind: 'page', pageId: 'e-home' } },
      await sectionFragment(),
    )
    expect(plan.report.colors.added.sort()).toEqual(['accent', 'primary'])
    expect(plan.report.rules.added).toEqual(['hero', 'hero-title', 'card', 'badge'])
    expect(plan.report.tables.created.sort()).toEqual(['contact', 'projects'])
    expect(plan.report.tables.rows).toBe(2)
    expect(plan.media.map((m) => m.id).sort()).toEqual(['media-bg', 'media-cover', 'media-font', 'media-photo'])
    expect(plan.report.warnings.filter((w) => w.code === 'missing-scale-group').map((w) => w.subject).sort()).toEqual(['space', 'text'])
    expect(plan.customProperties?.properties).toEqual({ '--radius': '12px', '--shadow': '0 0 4px var(--primary-50)' })
  })

  it('a page fragment adds its own page with a unique slug and links to itself', async () => {
    const source = makeSourceSite()
    source.pages[0].nodes.link.props.href = 'cms:page:page-home'
    const { fragment } = await extractFragment(
      fragmentSourceFromSite(source, { tables: SOURCE_TABLES, rows: SOURCE_ROWS, media: sourceMediaWithBytes() }),
      { pageId: 'page-home' },
    )
    const plan = planFragmentInsert({ site: makeTargetSite(), tables: TARGET_TABLES }, fragment)
    expect(plan.page?.slug).toBe('index-2')
    expect(plan.nodes[plan.roots[0]].moduleId).toBe('base.body')
    expect(nodeByModule(plan, 'base.link').props.href).toBe(`cms:page:${plan.page!.id}`)
  })

  it('refuses a second content outlet', async () => {
    const fragment = await sectionFragment()
    fragment.nodes.outlet = makeNode({ id: 'outlet', moduleId: 'base.outlet' })
    fragment.nodes.hero.children.push('outlet')
    const target = makeTargetSite()
    target.pages[0].nodes['t-outlet'] = makeNode({ id: 't-outlet', moduleId: 'base.outlet' })
    expect(() => planFragmentInsert(
      { site: target, tables: TARGET_TABLES, document: { kind: 'page', pageId: 't-home' } },
      fragment,
    )).toThrow(FragmentInsertError)
  })

  it('refuses to put a component inside itself', async () => {
    const target = makeTargetSite()
    let caught: unknown
    try {
      planFragmentInsert(
        { site: target, tables: TARGET_TABLES, document: { kind: 'visualComponent', vcId: 't-vc-card' } },
        await sectionFragment(),
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(FragmentInsertError)
    expect((caught as FragmentInsertError).code).toBe('component-cycle')
  })

  it('needs a document for a section', async () => {
    expect(() => planFragmentInsert({ site: makeTargetSite(), tables: [] }, structuredClone(sectionFragmentSync))).toThrow(FragmentInsertError)
  })
})

const sectionFragmentSync = await sectionFragment()
