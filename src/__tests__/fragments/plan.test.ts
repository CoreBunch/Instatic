/**
 * planFragmentInsert — every merge rule, against a populated and an empty site.
 */

import { describe, expect, it } from 'bun:test'
import {
  FRAGMENT_PROPERTIES_ORIGIN,
  FragmentInsertError,
  applyResolvedFragment,
  extractFragment,
  planFragmentInsert,
  resolveFragmentPlan,
  type FragmentInsertPlan,
  type SiteFragment,
} from '@core/fragments'
import { generateFrameworkRootCss, generateFrameworkUtilityClasses } from '@core/framework'
import { buildFontRoleTokens } from '@core/fonts'
import type { PageNode } from '@core/page-tree'
import { makeNode, makePage, makeSite } from '../fixtures'
import { TARGET_TABLES, extractFromSource, makeSourceSite, makeTargetSite, sourceWithBytes } from './fixtures'

// Planning is pure, so every test can read the same extracted section.
const { fragment } = await extractFromSource()

function planIntoTarget(target = makeTargetSite(), section: SiteFragment = fragment) {
  const plan = planFragmentInsert(
    { site: target, tables: TARGET_TABLES, document: { kind: 'page', pageId: 't-home' } },
    section,
  )
  return { plan, target }
}

function nodeByModule(plan: FragmentInsertPlan, moduleId: string): PageNode {
  const node = Object.values(plan.nodes).find((n) => n.moduleId === moduleId)
  if (!node) throw new Error(`no ${moduleId}`)
  return node
}

describe('planFragmentInsert — classes and rules', () => {
  it('installs optional classes with their tokens once and leaves them unassigned', async () => {
    const { fragment: section } = await extractFragment(
      sourceWithBytes(), { pageId: 'page-home', rootNodeIds: ['hero'] }, { optionalClassIds: ['cls-unrelated'] },
    )
    expect(section.tokens.colors.map(color => color.slug)).toContain('unused')
    const { plan, target } = planIntoTarget(makeTargetSite(), section)
    const optional = plan.styleRules.find(rule => rule.name === 'unrelated')!
    expect(optional.kind).toBe('class')
    expect(Object.values(plan.nodes).some(node => node.classIds.includes(optional.id))).toBe(false)
    target.styleRules[optional.id] = { ...optional, styles: { padding: '12px' } }
    const repeat = planIntoTarget(target, section).plan
    expect(repeat.report.rules.reused).toContain('unrelated')
    expect(repeat.styleRules.some(rule => rule.name === 'unrelated')).toBe(false)
  })

  it('mints fresh node ids for everything', () => {
    const { plan } = planIntoTarget()
    for (const id of Object.keys(plan.nodes)) expect(fragment.nodes[id]).toBeUndefined()
    expect(plan.roots).toHaveLength(1)
    expect(plan.nodes[plan.roots[0]].parentId).toBeNull()
  })

  it("reuses the site's class of the same name, even when its styles differ", () => {
    const { plan, target } = planIntoTarget()
    const hero = plan.nodes[plan.roots[0]]
    expect(hero.classIds).toContain('t-hero')
    expect(plan.styleRules.find((r) => r.name === 'hero')).toBeUndefined()
    expect(target.styleRules['t-hero'].styles).toEqual({ paddingTop: '99px' })
    expect(plan.report.rules.reused).toContain('hero')
  })

  it('adds missing classes after the existing cascade, in the fragment order', () => {
    const { plan, target } = planIntoTarget()
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

  it('keeps an ambient rule whose selector the site has, adds the others', () => {
    const { plan } = planIntoTarget()
    expect(plan.report.rules.ambientKept).toEqual(['.hero .hero-title:hover'])
    expect(plan.report.rules.ambientAdded).toEqual(['.page-wrap .hero-title', '@keyframes fade'])
  })

  it('preserves source variants and maps a reused class to all destination variants', () => {
    const section = structuredClone(fragment)
    const original = section.styleRules.find(rule => rule.name === 'hero' && rule.kind === 'class')!
    const hover = { ...original, id: 'source-hover', selector: '.hero:hover', order: original.order + 1 }
    section.styleRules.push(hover)
    section.nodes.hero.classIds.push(hover.id)
    const empty = makeSite({ pages: [makePage({ id: 't-home' })] })
    const added = planIntoTarget(empty, section).plan
    const newBinding = added.styleRules.filter(rule => rule.name === 'hero' && rule.kind === 'class')
    expect(newBinding.map(rule => rule.selector)).toEqual(['.hero'])
    expect(added.styleRules.find(rule => rule.selector === '.hero:hover')?.kind).toBe('ambient')
    const bound = added.nodes[added.roots[0]].classIds.filter(id => newBinding.some(rule => rule.id === id))
    expect(bound).toEqual([newBinding[0].id])

    const destination = makeTargetSite()
    destination.styleRules['target-hover'] = { ...destination.styleRules['t-hero'], id: 'target-hover', selector: '.hero:hover' }
    const reused = planIntoTarget(destination, section).plan
    expect(reused.nodes[reused.roots[0]].classIds.filter(id => ['t-hero', 'target-hover'].includes(id)))
      .toEqual(['t-hero', 'target-hover'])
    expect(reused.styleRules.some(rule => rule.selector === '.hero:hover')).toBe(false)
  })

  it('keeps exact destination selectors and preserves repeated source layers for missing selectors', () => {
    const section = structuredClone(fragment)
    const base = section.styleRules.find(rule => rule.name === 'hero' && rule.kind === 'class')!
    section.styleRules.push(
      { ...base, id: 'ambient-one', kind: 'ambient', selector: '.hero', styles: { borderRadius: '1px' } },
      { ...base, id: 'ambient-two', kind: 'ambient', selector: '.hero', styles: { borderRadius: '2px' }, order: base.order + 1 },
    )
    const target = makeTargetSite()
    const kept = planIntoTarget(target, section).plan
    expect(kept.styleRules.filter(rule => rule.selector === '.hero')).toEqual([])
    const owned = target.styleRules['t-hero']
    target.styleRules['t-hero'] = { ...owned, kind: 'ambient' }
    expect(planIntoTarget(target, section).plan.styleRules.find(rule => rule.selector === '.hero')?.styles).toEqual({})

    delete target.styleRules['t-hero']
    const added = planIntoTarget(target, section).plan
    expect(added.styleRules.filter(rule => rule.kind === 'ambient' && rule.selector === '.hero').map(rule => rule.styles.borderRadius))
      .toEqual(['1px', '2px'])
  })

  it('clones scoped module-style rules onto the new node ids', () => {
    const { plan } = planIntoTarget()
    const scoped = plan.styleRules.find((r) => r.scope)
    const hero = plan.nodes[plan.roots[0]]
    expect(scoped?.scope?.nodeId).toBe(hero.id)
    expect(hero.classIds).toContain(scoped!.id)
  })

  it('matches framework utilities by name after the token merge', () => {
    const { plan, target } = planIntoTarget()
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
  it('adds a missing colour with its full definition and keeps the existing one', () => {
    const { plan } = planIntoTarget()
    expect(plan.report.colors).toEqual({ added: ['accent'], kept: ['primary'], filled: [] })
    const accent = plan.colorTokens[0]
    expect(accent.slug).toBe('accent')
    expect(accent.lightValue).toBe('#ff8800')
    expect(accent.generateTransparent).toBe(true)
    expect(accent.generateUtilities).toEqual({ text: true, background: true, border: false, fill: false })
    expect(accent.id).not.toBe('col-accent')
  })

  it("fills a missing colour from one of the site's own when the caller asks", () => {
    const target = makeTargetSite()
    const primary = target.settings.framework!.colors.tokens.find((t) => t.slug === 'primary')!
    const plan = planFragmentInsert(
      { site: target, tables: TARGET_TABLES, document: { kind: 'page', pageId: 't-home' } },
      fragment,
      { colorSources: { accent: 'primary', primary: 'accent' } },
    )
    const accent = plan.colorTokens.find((t) => t.slug === 'accent')!
    // The site's values, the fragment's generation flags; a colour the site
    // already has is untouched whatever the caller asks.
    expect(accent.lightValue).toBe(primary.lightValue)
    expect(accent.darkValue).toBe(primary.darkValue)
    expect(accent.generateTransparent).toBe(true)
    expect(plan.report.colors).toEqual({ added: ['accent'], kept: ['primary'], filled: [{ slug: 'accent', from: 'primary' }] })

    const unknown = planFragmentInsert(
      { site: makeTargetSite(), tables: TARGET_TABLES, document: { kind: 'page', pageId: 't-home' } },
      fragment,
      { colorSources: { accent: 'no-such-colour' } },
    )
    expect(unknown.colorTokens.find((t) => t.slug === 'accent')!.lightValue).toBe('#ff8800')
    expect(unknown.report.colors.filled).toEqual([])
  })

  it("warns about colour variants the site's colour does not generate", () => {
    const { plan } = planIntoTarget()
    const subjects = plan.report.warnings.filter((w) => w.code === 'color-variant-missing').map((w) => w.subject)
    expect(subjects).toEqual(['--primary-d-2'])
  })

  it("inserts missing steps into the site's own scale and keeps its base step", () => {
    const { plan } = planIntoTarget()
    const typography = plan.scaleSteps.find((s) => s.family === 'typography')
    const spacing = plan.scaleSteps.find((s) => s.family === 'spacing')
    expect(typography).toEqual({ family: 'typography', groupId: 't-type', steps: 'xs,s,m,l,xl', baseScaleIndex: 2 })
    // `s` lands before the base step `m`, so the base index moves with it.
    expect(spacing).toEqual({ family: 'spacing', groupId: 't-space', steps: 's,m,l', baseScaleIndex: 1 })
  })

  it('adds the missing font token with its family', () => {
    const { plan } = planIntoTarget()
    expect(plan.report.fonts.tokensAdded).toEqual(['font-heading'])
    expect(plan.fontFamilies.map((f) => f.entry.family)).toEqual(['Inter'])
    // Bound to the family being installed until the commit knows its real id.
    expect(plan.fontTokens[0].familyId).toBe(plan.fontFamilies[0].fragmentFamilyId)
  })

  it("keeps a new site's seeded font roles and installs nothing for them", () => {
    const target = makeTargetSite()
    target.settings.fonts = { items: [], tokens: buildFontRoleTokens() }
    const { plan } = planIntoTarget(target)
    expect(plan.report.fonts.tokensKept).toEqual(['font-heading'])
    expect(plan.fontTokens).toEqual([])
    // The fragment bound Inter to font-heading; the site's role wins, so Inter
    // and its file are not needed.
    expect(plan.fontFamilies).toEqual([])
    expect(plan.media.map((m) => m.id)).not.toContain('media-font')
  })

  it('puts root custom properties the site lacks into one engine-owned :root rule', () => {
    const { plan, target } = planIntoTarget()
    expect(plan.report.customProperties).toEqual({ added: ['--shadow'], kept: ['--radius'] })
    expect(target.styleRules[plan.customProperties!.ruleId]).toBeUndefined()
    expect(plan.customProperties?.properties).toEqual({ '--shadow': '0 0 4px var(--primary-50)' })
  })

  it('reuses the engine-owned :root rule on a second insert', () => {
    const target = makeTargetSite()
    target.styleRules['owned'] = {
      id: 'owned', name: ':root', kind: 'ambient', selector: ':root', order: 50,
      styles: { '--other': '1' }, contextStyles: {},
      origin: { source: FRAGMENT_PROPERTIES_ORIGIN, ordinal: 0 },
      createdAt: 1, updatedAt: 1,
    }
    const { plan } = planIntoTarget(target)
    expect(plan.customProperties).toEqual({ ruleId: 'owned', order: 50, properties: { '--shadow': '0 0 4px var(--primary-50)' } })
  })
})

describe('planFragmentInsert — components, tables, links, media', () => {
  it("points instances at the site's component of the same name and skips its nested ones", () => {
    const { plan } = planIntoTarget()
    expect(nodeByModule(plan, 'base.visual-component-ref').props.componentId).toBe('t-vc-card')
    expect(plan.report.components).toEqual({ added: [], reused: ['Card'] })
    expect(plan.components).toEqual([])
  })

  it('adds components the site lacks, nested ones included, with fresh ids', () => {
    const target = makeTargetSite()
    target.visualComponents = []
    const { plan } = planIntoTarget(target)
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

  it('reuses a table by slug, adds its missing fields, creates the missing one', () => {
    const { plan } = planIntoTarget()
    expect(plan.report.tables).toEqual({ created: ['contact'], reused: ['projects'], fieldsAdded: ['projects.cover'], rows: 0 })
    const reuse = plan.tables.find((t) => t.action === 'reuse')!
    expect(reuse.action === 'reuse' && reuse.addFields.map((f) => f.id)).toEqual(['cover'])
    expect(plan.report.warnings.some((w) => w.code === 'relation-field-dropped' && w.subject === 'projects.owner')).toBe(true)
    const loop = nodeByModule(plan, 'base.loop')
    expect((loop.props.filters as Record<string, unknown>).tableId).toBe('t-tbl-projects')
    // The created table's id comes from the server at commit time.
    expect(nodeByModule(plan, 'base.form').props.targetTableId).toBe('tbl-contact')
  })

  it('remaps a link to a page the site has by slug, and turns the rest into #', () => {
    const { plan } = planIntoTarget()
    expect(nodeByModule(plan, 'base.link').props.href).toBe('cms:page:t-about#team')
    expect(plan.report.links).toEqual({ remapped: ['about'], unresolved: [] })

    const target = makeTargetSite()
    target.pages = target.pages.filter((p) => p.slug !== 'about')
    const { plan: plan2 } = planIntoTarget(target)
    expect(nodeByModule(plan2, 'base.link').props.href).toBe('#')
    expect(plan2.report.links.unresolved).toEqual(['about'])
  })

  it('plans only the media the inserted content uses', () => {
    const { plan } = planIntoTarget()
    // cover.jpg is only used by rows of the reused projects table, which are
    // not added; bg.jpg only by the fragment's `hero`, and the site's wins.
    expect(plan.media.map((m) => m.id).sort()).toEqual(['media-font', 'media-photo'])
  })

  it('carries media referenced by a root variable only when the destination needs it', async () => {
    const source = makeSourceSite()
    source.pages[0].nodes.photo.props.src = ''
    source.styleRules['cls-root'].styles['--hero-photo'] = 'url(/uploads/photo.jpg)'
    source.styleRules['cls-hero-title'].styles.backgroundImage = 'var(--hero-photo)'
    const picked = await extractFragment(sourceWithBytes(source), { pageId: 'page-home', rootNodeIds: ['hero'] })
    expect(picked.fragment.media.some(media => media.id === 'media-photo')).toBe(true)
    const target = makeTargetSite()
    expect(planIntoTarget(target, picked.fragment).plan.media.some(media => media.id === 'media-photo')).toBe(true)
    target.styleRules['t-root'].styles['--hero-photo'] = 'none'
    expect(planIntoTarget(target, picked.fragment).plan.media.some(media => media.id === 'media-photo')).toBe(false)
  })

  it('repeats the outside dependencies the extractor found', () => {
    const { plan } = planIntoTarget()
    expect(plan.report.outsideDependencies).toEqual([{ selector: '.page-wrap .hero-title', classes: ['page-wrap'] }])
  })
})

describe('planFragmentInsert — empty site, pages and guards', () => {
  it('into an empty site: everything is added', () => {
    const empty = makeSite({ pages: [makePage({ id: 'e-home' })] })
    const plan = planFragmentInsert(
      { site: empty, tables: [], document: { kind: 'page', pageId: 'e-home' } },
      fragment,
    )
    expect(plan.report.colors.added.sort()).toEqual(['accent', 'primary'])
    expect(plan.report.rules.added).toEqual(['hero', 'hero-title', 'card', 'badge'])
    expect(plan.report.tables.created.sort()).toEqual(['contact', 'projects'])
    expect(plan.report.tables.rows).toBe(2)
    expect(plan.media.map((m) => m.id).sort()).toEqual(['media-bg', 'media-cover', 'media-font', 'media-photo'])
    expect(plan.report.warnings.filter((w) => w.code === 'missing-scale-group')).toEqual([])
    expect(plan.scaleGroups.typography.map(group => group.namingConvention)).toEqual(['text'])
    expect(plan.scaleGroups.spacing.map(group => group.namingConvention)).toEqual(['space'])
    expect(plan.customProperties?.properties).toEqual({ '--radius': '12px', '--shadow': '0 0 4px var(--primary-50)' })
  })

  it('creates scale groups from names-only fragments and renders the same sizes in either import order', () => {
    const sections = ['6xl', '7xl'].map(step => ({
      ...fragment,
      tokens: {
        colors: [],
        fontTokens: [],
        fontFamilies: [],
        customProperties: {},
        typeSteps: [{ convention: 'text', step }],
        spaceSteps: [{ convention: 'space', step: '2xl' }],
      },
    }))
    const insert = (orderedSections: SiteFragment[]) => {
      const page = makePage({ id: 'home' })
      const site = makeSite({ pages: [page] })
      for (const [index, section] of orderedSections.entries()) {
        const plan = planFragmentInsert({ site, tables: [], document: { kind: 'page', pageId: page.id } }, section)
        const resolved = resolveFragmentPlan(plan, {
          mediaUrlByPath: new Map(), tableIdMap: new Map(), fontEntryByFamilyId: new Map(),
        })
        const result = applyResolvedFragment(site, resolved, { tree: site.pages[0], parentId: page.rootNodeId })
        if (index === 0) expect(result.frameworkChanged).toBe(true)
      }
      const framework = site.settings.framework!
      expect(framework.typography?.groups).toHaveLength(1)
      expect(framework.spacing?.groups).toHaveLength(1)
      expect(framework.preferences?.rootFontSize).toBe(16)
      expect(generateFrameworkUtilityClasses(framework)).toEqual({})
      return generateFrameworkRootCss(framework)
    }
    const css = insert(sections)
    expect(css).not.toContain('html {')
    expect(css).toContain('--text-7xl: clamp(')
    expect(css).toContain('--space-2xl: clamp(')
    expect(insert(sections.toReversed())).toBe(css)
  })

  it('keeps the configured sizes at an internal gap and leaves a disabled scale disabled', () => {
    const site = makeTargetSite()
    const framework = site.settings.framework!
    Object.assign(framework.typography!.groups[0], { steps: 'xs,m,xl', baseScaleIndex: 1 })
    framework.spacing!.isDisabled = true
    const { plan } = planIntoTarget(site, {
      ...fragment,
      tokens: {
        ...fragment.tokens,
        typeSteps: [{ convention: 'text', step: 's' }],
      },
    })
    expect(plan.scaleGroups).toEqual({ typography: [], spacing: [] })
    expect(plan.scaleSteps).toEqual([])
    expect(plan.report.warnings.filter(warning => warning.code === 'scale-step-not-added')).toHaveLength(1)
    expect(framework.typography!.groups[0].steps).toBe('xs,m,xl')
  })

  it('a page fragment adds its own page with a unique slug and links to itself', async () => {
    const source = makeSourceSite()
    source.pages[0].nodes.link.props.href = 'cms:page:page-home'
    const { fragment: page } = await extractFragment(sourceWithBytes(source), { pageId: 'page-home' })
    const plan = planFragmentInsert({ site: makeTargetSite(), tables: TARGET_TABLES }, page)
    expect(plan.page?.slug).toBe('index-2')
    expect(plan.nodes[plan.roots[0]].moduleId).toBe('base.body')
    expect(nodeByModule(plan, 'base.link').props.href).toBe(`cms:page:${plan.page!.id}`)
  })

  it('refuses a second content outlet', () => {
    const withOutlet = structuredClone(fragment)
    withOutlet.nodes.outlet = makeNode({ id: 'outlet', moduleId: 'base.outlet' })
    withOutlet.nodes.hero.children.push('outlet')
    const target = makeTargetSite()
    target.pages[0].nodes['t-outlet'] = makeNode({ id: 't-outlet', moduleId: 'base.outlet' })
    expect(() => planIntoTarget(target, withOutlet)).toThrow(FragmentInsertError)
  })

  it('refuses to put a component inside itself', () => {
    let caught: unknown
    try {
      planFragmentInsert(
        { site: makeTargetSite(), tables: TARGET_TABLES, document: { kind: 'visualComponent', vcId: 't-vc-card' } },
        fragment,
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(FragmentInsertError)
    expect((caught as FragmentInsertError).code).toBe('component-cycle')
  })

  it('needs a document for a section', () => {
    expect(() => planFragmentInsert({ site: makeTargetSite(), tables: [] }, fragment)).toThrow(FragmentInsertError)
  })
})
