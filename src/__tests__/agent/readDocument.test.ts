import { describe, expect, it, beforeAll } from 'bun:test'
import { renderAgentDocument, type AgentDocumentRenderOptions } from '@core/ai'
import { registry } from '@core/module-engine'
import { classKindSelector, type Page, type SiteDocument } from '@core/page-tree'
import { makePage, makeSite } from '../publisher/helpers'

beforeAll(async () => {
  await import('../../../src/modules/base') // register base modules in this process
})

function fixture(): { page: Page; site: SiteDocument } {
  const page = makePage({
    root: { moduleId: 'base.body', children: ['t'] },
    t: { moduleId: 'base.text', props: { text: 'Hi', tag: 'h1' } },
  })
  const site = makeSite({
    pages: [page],
    styleRules: {
      r1: { id: 'r1', name: 'heading', kind: 'ambient', selector: 'h1', order: 0, styles: { color: 'red' } },
    },
  })
  return { page, site }
}

function renderDoc(
  page: Page,
  site: SiteDocument,
  options?: AgentDocumentRenderOptions,
) {
  return renderAgentDocument(page, site, registry, options)
}

describe('renderAgentDocument', () => {
  it('returns an annotated body with uid attributes and a <style> css bundle', () => {
    const { page, site } = fixture()
    const { html, css, pageInfo } = renderDoc(page, site)
    expect(html).toContain('uid="t"') // node addressable
    expect(html).toContain('Hi') // content present
    expect(html).not.toContain('<head>') // body only, not full document
    expect(css.startsWith('<style>')).toBe(true)
    expect(css).toContain('</style>')
    expect(pageInfo.part).toBe(1)
    expect(pageInfo.totalParts).toBe(1)
    expect(pageInfo.nextPart).toBeNull()
  })

  it('pages oversized read_document payloads with exact ranges for follow-up reads', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['one', 'two', 'three'] },
      one: { moduleId: 'base.text', props: { text: 'FIRST-' + 'a'.repeat(900), tag: 'p' } },
      two: { moduleId: 'base.text', props: { text: 'SECOND-' + 'b'.repeat(900), tag: 'p' } },
      three: { moduleId: 'base.text', props: { text: 'THIRD-' + 'c'.repeat(900), tag: 'p' } },
    })
    const site = makeSite({ pages: [page] })

    const first = renderDoc(page, site, { maxSerializedChars: 1400 })
    const second = renderDoc(page, site, { maxSerializedChars: 1400, part: 2 })

    expect(first.pageInfo.totalParts).toBeGreaterThan(1)
    expect(first.pageInfo.nextPart).toBe(2)
    expect(first.pageInfo.ranges[0]).toMatchObject({ field: 'html', start: 0 })
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(first.pageInfo.maxChars)
    expect(JSON.stringify(second).length).toBeLessThanOrEqual(second.pageInfo.maxChars)
    expect(second.pageInfo.part).toBe(2)
    expect(second.pageInfo.ranges[0]!.start).toBe(first.pageInfo.ranges.at(-1)!.end)
    expect([first.html, second.html].join('')).toContain('SECOND-')
  })

  it('cleans base64 data URLs and very long URLs before paging', () => {
    const longBase64 = 'A'.repeat(1600)
    const longUrl = `https://cdn.example.com/assets/${'path-'.repeat(180)}hero.png?signature=${'b'.repeat(500)}`
    const page = makePage({
      root: { moduleId: 'base.body', children: ['inlineData', 'remoteImage'] },
      // The base64 payload rides TEXT CONTENT — the one channel that still
      // legitimately reaches the read surface (a pasted blob in a paragraph).
      // URL-bearing attributes can no longer carry it: `isSafeUrl` rejects
      // data: schemes in src/href, and sanitizeRenderableHtmlAttribute
      // (@core/htmlAttributes) rejects data:-scheme values in custom
      // attributes outright.
      inlineData: {
        moduleId: 'base.text',
        props: { text: `Pasted blob: data:image/png;base64,${longBase64}`, tag: 'p' },
      },
      remoteImage: { moduleId: 'base.image', props: { src: longUrl } },
    })
    const site = makeSite({
      pages: [page],
      styleRules: {
        bg: {
          id: 'bg',
          name: 'img',
          kind: 'ambient',
          selector: 'img',
          order: 0,
          styles: { backgroundImage: `url("${longUrl}")` },
          contextStyles: {},
          createdAt: 0,
          updatedAt: 0,
        },
      },
    })

    const { html, css, pageInfo } = renderDoc(page, site)

    expect(html).not.toContain(longBase64)
    expect(html).not.toContain(longUrl)
    expect(css).not.toContain(longUrl)
    expect(html).toContain('data:image/png;base64,[omitted 1600 chars]')
    expect(html).toContain('...[truncated ')
    expect(css).toContain('...[truncated ')
    expect(pageInfo.cleanedStrings.base64DataUrls).toBe(1)
    expect(pageInfo.cleanedStrings.longUrls).toBeGreaterThanOrEqual(2)
  })

  it('omits ambient CSS selectors that cannot apply to the active page class tokens', () => {
    const heroClass = {
      id: 'hero',
      name: 'hero',
      kind: 'class' as const,
      selector: classKindSelector('hero'),
      order: 0,
      styles: { color: 'green' },
      contextStyles: {},
      createdAt: 0,
      updatedAt: 0,
    }
    const titleClass = {
      id: 'title',
      name: 'title',
      kind: 'class' as const,
      selector: classKindSelector('title'),
      order: 1,
      styles: {},
      contextStyles: {},
      createdAt: 0,
      updatedAt: 0,
    }
    const page = makePage({
      root: { moduleId: 'base.body', children: ['heroNode'] },
      heroNode: { moduleId: 'base.container', classIds: ['hero'], children: ['titleNode'] },
      titleNode: { moduleId: 'base.text', classIds: ['title'], props: { text: 'Hi', tag: 'h1' } },
    })
    const site = makeSite({
      pages: [page],
      styleRules: {
        hero: heroClass,
        title: titleClass,
        relevant: {
          id: 'relevant',
          name: '.hero .title',
          kind: 'ambient',
          selector: '.hero .title',
          order: 2,
          styles: { letterSpacing: '1px' },
          contextStyles: {},
          createdAt: 0,
          updatedAt: 0,
        },
        globalElement: {
          id: 'globalElement',
          name: 'h1',
          kind: 'ambient',
          selector: 'h1',
          order: 3,
          styles: { fontWeight: '700' },
          contextStyles: {},
          createdAt: 0,
          updatedAt: 0,
        },
        unrelated: {
          id: 'unrelated',
          name: '.pricing-card .price',
          kind: 'ambient',
          selector: '.pricing-card .price',
          order: 4,
          styles: { color: 'red' },
          contextStyles: {},
          createdAt: 0,
          updatedAt: 0,
        },
        partlyUnrelated: {
          id: 'partlyUnrelated',
          name: '.hero .missing',
          kind: 'ambient',
          selector: '.hero .missing',
          order: 5,
          styles: { color: 'orange' },
          contextStyles: {},
          createdAt: 0,
          updatedAt: 0,
        },
      },
    })

    const { css } = renderDoc(page, site)

    expect(css).toContain('.hero {')
    expect(css).toContain('.hero .title {')
    expect(css).toContain('h1 {')
    expect(css).not.toContain('.pricing-card .price')
    expect(css).not.toContain('.hero .missing')
  })

  it('keeps font token variables but omits browser-only font-face blocks', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['t'] },
      t: { moduleId: 'base.text', props: { text: 'Hi', tag: 'h1' } },
    })
    const site = makeSite({
      pages: [page],
      settings: {
        ...makeSite().settings,
        fonts: {
          items: [{
            id: 'font-1',
            source: 'custom',
            family: 'Example Sans',
            variants: ['400'],
            subsets: ['latin'],
            files: [{
              path: '/uploads/example.woff2',
              format: 'woff2',
              variant: '400',
            }],
            createdAt: 0,
            updatedAt: 0,
          }],
          tokens: [{
            id: 'token-1',
            name: 'Heading',
            variable: 'font-heading',
            familyId: 'font-1',
            fallback: 'sans-serif',
            order: 0,
            createdAt: 0,
            updatedAt: 0,
          }],
        },
      },
    })

    const { css } = renderDoc(page, site)

    expect(css).toContain('--font-heading:')
    expect(css).toContain('"Example Sans", sans-serif')
    expect(css).not.toContain('@font-face')
    expect(css).not.toContain('/uploads/example.woff2')
  })
})

describe('catalog derivations', () => {
  it('describes modules from the registry (base.text present, base.body excluded)', async () => {
    const { describeAgentModules } = await import('../../../server/ai/tools/site/render')
    const mods = describeAgentModules()
    const ids = mods.map((m) => m.id)
    expect(ids).toContain('base.text')
    expect(ids).not.toContain('base.body')
  })

  it('describes tokens from site.settings', async () => {
    const { describeAgentTokens } = await import('../../../server/ai/tools/site/render')
    const tokens = describeAgentTokens(fixture().site)
    expect(tokens).toHaveProperty('colors')
    expect(tokens).toHaveProperty('fonts')
  })

  it('filterTokenFamily narrows to one family', async () => {
    const { describeAgentTokens, filterTokenFamily } = await import(
      '../../../server/ai/tools/site/render'
    )
    const tokens = describeAgentTokens(fixture().site)
    const onlyColors = filterTokenFamily(tokens, 'colors')
    expect(onlyColors.colors).toBe(tokens.colors)
    expect(onlyColors.typography).toEqual([])
    expect(onlyColors.spacing).toEqual([])
    expect(onlyColors.fonts).toEqual([])
  })
})
