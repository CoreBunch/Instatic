import { describe, expect, it } from 'bun:test'
import type { Page, SiteDocument } from '@core/page-tree'
import { renderNode, type RenderConfig, type RenderAccumulators } from '@core/publisher'
import { buildPageFrame, buildRouteFrame, buildSiteFrame } from '@core/templates/contextFrames'
import { makeModule, makeRegistry, makeAccumulators } from './helpers'

describe('Issue #548 Problem Assumption Verification', () => {
  it('reproduces that entryStack = [] in hole templateContext causes currentEntry bindings to resolve as empty', () => {
    // Register test modules
    const containerMod = makeModule('base.container', {
      canHaveChildren: true,
      render: (_props, children) => ({ html: `<div>${children}</div>` }),
    })
    const textMod = makeModule('base.text', {
      canHaveChildren: false,
      render: (props, _children, _config) => {
        const content = String(props.content ?? '')
        return { html: `<span>${content}</span>` }
      },
    })

    const testRegistry = makeRegistry({
      'base.container': containerMod,
      'base.text': textMod,
    })

    // 1. Create a page with dynamic bindings referencing currentEntry.slug
    const page: Page = {
      id: 'page_1',
      title: 'Course Page Template',
      slug: 'courses/[slug]',
      nodes: {
        root: {
          id: 'root',
          moduleId: 'base.container',
          props: {},
          children: ['text_node'],
        },
        text_node: {
          id: 'text_node',
          moduleId: 'base.text',
          props: {
            content: 'Course: {currentEntry.slug}, Region: {route.query.region}',
          },
          dynamicBindings: {
            content: 'Course: {currentEntry.slug}, Region: {route.query.region}',
          },
          children: [],
        },
      },
    }

    const site: SiteDocument = {
      id: 'site_1',
      title: 'My Site',
      name: 'My Site',
      pages: [],
      files: [],
      visualComponents: {},
    } as unknown as SiteDocument

    const route = buildRouteFrame('/courses/time-management?region=cz')

    // Current hole behavior: entryStack is empty []
    const holeConfigWithBug: RenderConfig = {
      page,
      site,
      registry: testRegistry,
      loopData: new Map(),
      templateContext: {
        entryStack: [], // 👈 THE BUG: Empty entryStack!
        page: buildPageFrame(page),
        site: buildSiteFrame(site),
        route,
      },
    }

    const acc = makeAccumulators()
    const renderedHtml = renderNode('root', holeConfigWithBug, acc)

    console.log('\n--- REPRODUCTION TEST OUTPUT ---')
    console.log('Rendered Hole HTML:', renderedHtml)
    console.log('--------------------------------\n')

    // Region resolves correctly because route frame is present:
    expect(renderedHtml).toContain('Region: cz')
    
    // BUT currentEntry.slug is MISSING because entryStack is []:
    const hasCourseSlug = renderedHtml.includes('time-management')
    console.log('Did currentEntry.slug ("time-management") resolve inside hole?', hasCourseSlug)

    // EMPIRICAL PROOF: In the current code (with entryStack: []), "time-management" is NOT present!
    expect(hasCourseSlug).toBe(false)
  })

  it('proves that seeding entryStack resolves currentEntry.slug correctly inside dynamic hole fragment', () => {
    const containerMod = makeModule('base.container', {
      canHaveChildren: true,
      render: (_props, children) => ({ html: `<div>${children}</div>` }),
    })
    const textMod = makeModule('base.text', {
      canHaveChildren: false,
      render: (props, _children, _config) => {
        const content = String(props.content ?? '')
        return { html: `<span>${content}</span>` }
      },
    })

    const testRegistry = makeRegistry({
      'base.container': containerMod,
      'base.text': textMod,
    })

    const page: Page = {
      id: 'page_1',
      title: 'Course Page Template',
      slug: 'courses/[slug]',
      nodes: {
        root: {
          id: 'root',
          moduleId: 'base.container',
          props: {},
          children: ['text_node'],
        },
        text_node: {
          id: 'text_node',
          moduleId: 'base.text',
          props: {
            content: 'Course: {currentEntry.slug}, Region: {route.query.region}',
          },
          dynamicBindings: {
            content: 'Course: {currentEntry.slug}, Region: {route.query.region}',
          },
          children: [],
        },
      },
    }

    const site: SiteDocument = {
      id: 'site_1',
      title: 'My Site',
      name: 'My Site',
      pages: [],
      files: [],
      visualComponents: {},
    } as unknown as SiteDocument

    const route = buildRouteFrame('/courses/time-management?region=cz')

    // THE FIX: Seed entryStack with resolved entry!
    const resolvedEntryItem = {
      id: 'entry_101',
      slug: 'time-management',
      fields: {
        title: 'Time Management',
        slug: 'time-management',
      },
    }

    const holeConfigFixed: RenderConfig = {
      page,
      site,
      registry: testRegistry,
      loopData: new Map(),
      templateContext: {
        entryStack: [resolvedEntryItem], // 👈 SEEDED entryStack!
        page: buildPageFrame(page),
        site: buildSiteFrame(site),
        route,
      },
    }

    const acc = makeAccumulators()
    const renderedHtml = renderNode('root', holeConfigFixed, acc)

    console.log('\n--- FIXED HOLE RENDER OUTPUT ---')
    console.log('Rendered Hole HTML:', renderedHtml)
    console.log('--------------------------------\n')

    expect(renderedHtml).toContain('Course: time-management, Region: cz')
  })
})
