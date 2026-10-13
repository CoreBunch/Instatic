/**
 * extractFragment — the closure a section, page or component carries.
 */

import { describe, expect, it } from 'bun:test'
import {
  FragmentExtractError,
  extractFragment,
  fragmentSourceFromBundle,
  fragmentSourceFromSite,
  readFragmentPackage,
  sha256Hex,
  writeFragmentPackage,
} from '@core/fragments'
import { pageToCells } from '@core/data/pageFromRow'
import { visualComponentToCells } from '@core/data/componentFromRow'
import type { DataRow } from '@core/data/schemas'
import type { SiteBundle } from '@core/data/bundleSchema'
import {
  SOURCE_FRAMEWORK,
  SOURCE_ROWS,
  SOURCE_TABLES,
  frameworkClassId,
  makeSourceSite,
  mediaBytesFor,
  sourceMediaWithBytes,
} from './fixtures'

function source() {
  return fragmentSourceFromSite(makeSourceSite(), {
    tables: SOURCE_TABLES,
    rows: SOURCE_ROWS,
    media: sourceMediaWithBytes(),
  })
}

describe('extractFragment — section closure', () => {
  it('carries the subtree, its classes and the ambient rules built on them', async () => {
    const { fragment } = await extractFragment(source(), { pageId: 'page-home', rootNodeIds: ['hero'] })

    expect(fragment.kind).toBe('section')
    expect(fragment.roots).toEqual(['hero'])
    expect(Object.keys(fragment.nodes).sort()).toEqual(
      ['card-ref', 'form', 'hero', 'link', 'loop', 'loop-item', 'photo', 'title'].sort(),
    )
    expect(fragment.nodes.hero.parentId).toBeNull()
    // The unselected sibling and the ancestor wrapper stay behind.
    expect(fragment.nodes.other).toBeUndefined()

    const ruleIds = fragment.styleRules.map((r) => r.id)
    expect(ruleIds).toContain('cls-hero')
    expect(ruleIds).toContain('cls-hero-title')
    expect(ruleIds).toContain('cls-hero-hover') // ambient on carried classes
    expect(ruleIds).toContain('cls-scoped') // scoped module-style rule
    expect(ruleIds).toContain('cls-keyframes') // the animation the hero runs
    expect(ruleIds).toContain('cls-card') // from the Visual Component closure
    expect(ruleIds).toContain('cls-badge') // nested component
    expect(ruleIds).toContain('cls-wrap-h') // names a carried class
    expect(ruleIds).not.toContain('cls-page-wrap')
    expect(ruleIds).not.toContain('cls-unrelated')
    expect(ruleIds).not.toContain('cls-wrap-other')
  })

  it('carries framework utilities by name only', async () => {
    const { fragment } = await extractFragment(source(), { pageId: 'page-home', rootNodeIds: ['hero'] })
    const textXl = fragment.styleRules.find((r) => r.id === frameworkClassId(SOURCE_FRAMEWORK, 'text-xl'))
    expect(textXl?.name).toBe('text-xl')
    expect(textXl?.styles).toEqual({})
    expect(textXl?.generated?.family).toBe('typography')
  })

  it('reports rules that depend on an ancestor-only class', async () => {
    const { fragment } = await extractFragment(source(), { pageId: 'page-home', rootNodeIds: ['hero'] })
    expect(fragment.outsideDependencies).toEqual([
      { selector: '.page-wrap .hero-title', classes: ['page-wrap'] },
    ])
  })

  it('collects conditions, components, tokens, tables, media and links', async () => {
    const { fragment, warnings } = await extractFragment(source(), { pageId: 'page-home', rootNodeIds: ['hero'] })

    expect(fragment.conditions.map((c) => c.id)).toEqual(['media:(hover: hover)'])
    expect(fragment.components.map((c) => c.id).sort()).toEqual(['vc-badge', 'vc-card'])

    // Colours: primary via a shade variant and a framework utility, accent via
    // a hover rule and the Card; the unused colour stays home. Full
    // definitions travel, generation flags included.
    const colors = fragment.tokens.colors
    expect(colors.map((c) => c.slug).sort()).toEqual(['accent', 'primary'])
    expect(colors.find((c) => c.slug === 'primary')?.generateShades).toEqual({ enabled: true, count: 3 })

    expect(fragment.tokens.typeSteps).toEqual([{ convention: 'text', step: 'xl' }])
    expect(fragment.tokens.spaceSteps.map((s) => s.step).sort()).toEqual(['l', 's'])
    expect(fragment.tokens.fontTokens.map((t) => t.variable)).toEqual(['font-heading'])
    expect(fragment.tokens.fontFamilies.map((f) => f.family)).toEqual(['Inter'])
    // --shadow is a root property that itself reads --primary-50.
    expect(fragment.tokens.customProperties).toEqual({ '--radius': '12px', '--shadow': '0 0 4px var(--primary-50)' })

    const projects = fragment.tables.find((t) => t.slug === 'projects')
    const contact = fragment.tables.find((t) => t.slug === 'contact')
    expect(projects?.rows?.map((r) => r.id)).toEqual(['row-1', 'row-2'])
    expect(projects?.rows?.[1].status).toBe('draft')
    expect(contact?.rows).toBeUndefined() // a form carries the schema only

    expect(fragment.media.map((m) => m.id).sort()).toEqual(['media-bg', 'media-cover', 'media-font', 'media-photo'])
    const photo = fragment.media.find((m) => m.id === 'media-photo')!
    expect(photo.key).toBe(await sha256Hex(mediaBytesFor('media-photo')))
    expect(photo.src).toBe(`media/${photo.key}.jpg`)
    expect(photo.path).toBe('/uploads/photo.jpg')
    expect(photo.alt).toBe('A photo')

    expect(fragment.links).toEqual([{ pageId: 'page-about', slug: 'about' }])
    expect(warnings).toEqual([])
  })

  it('keeps dynamic bindings verbatim', async () => {
    const { fragment } = await extractFragment(source(), { pageId: 'page-home', rootNodeIds: ['hero'] })
    expect(fragment.nodes['loop-item'].props.text).toBe('{currentEntry.title}')
    expect(fragment.nodes['loop-item'].dynamicBindings).toEqual({ text: { source: 'currentEntry', field: 'title' } })
  })

  it('throws a typed error for a selection that does not resolve', async () => {
    await expect(extractFragment(source(), { pageId: 'nope' })).rejects.toBeInstanceOf(FragmentExtractError)
    await expect(extractFragment(source(), { pageId: 'page-home', rootNodeIds: ['ghost'] })).rejects.toBeInstanceOf(FragmentExtractError)
  })
})

describe('extractFragment — page and component', () => {
  it('a whole page carries its body and title/slug', async () => {
    const { fragment } = await extractFragment(source(), { pageId: 'page-home' })
    expect(fragment.kind).toBe('page')
    expect(fragment.roots).toEqual(['body'])
    expect(fragment.page).toEqual({ title: 'Home', slug: 'index' })
    // The wrapper is inside the page now, so it is carried, not an outside dependency.
    expect(fragment.styleRules.map((r) => r.id)).toContain('cls-page-wrap')
    expect(fragment.outsideDependencies).toBeUndefined()
  })

  it('a component becomes one instance of it plus the component closure', async () => {
    const { fragment } = await extractFragment(source(), { componentId: 'vc-card' })
    expect(fragment.kind).toBe('component')
    expect(fragment.component).toEqual({ id: 'vc-card', name: 'Card' })
    const root = fragment.nodes[fragment.roots[0]]
    expect(root.moduleId).toBe('base.visual-component-ref')
    expect(root.props.componentId).toBe('vc-card')
    expect(fragment.components.map((c) => c.id).sort()).toEqual(['vc-badge', 'vc-card'])
    expect(fragment.tokens.colors.map((c) => c.slug).sort()).toEqual(['accent', 'primary'])
  })
})

describe('extractFragment — bundle source', () => {
  function bundle(): SiteBundle {
    const site = makeSourceSite()
    const { pages, visualComponents, layouts: _layouts, ...shell } = site
    const asRow = (id: string, tableId: string, slug: string, cells: Record<string, unknown>): DataRow => ({
      ...SOURCE_ROWS[0],
      id,
      tableId,
      slug,
      cells,
    })
    return {
      schemaVersion: 1,
      exportedAt: '2026-10-13T00:00:00.000Z',
      site: shell,
      tables: [
        { ...SOURCE_TABLES[0], id: 'pages', slug: 'pages', name: 'Pages', kind: 'page', system: true },
        { ...SOURCE_TABLES[0], id: 'components', slug: 'components', name: 'Components', kind: 'component', system: true },
        ...SOURCE_TABLES,
      ],
      rows: [
        ...pages.map((p) => asRow(p.id, 'pages', p.slug, pageToCells(p))),
        ...visualComponents.map((vc) => asRow(vc.id, 'components', vc.id, visualComponentToCells(vc))),
        ...SOURCE_ROWS,
      ],
      media: sourceMediaWithBytes().map((m) => ({
        id: m.id,
        filename: m.filename,
        mimeType: m.mimeType,
        sizeBytes: m.sizeBytes ?? 0,
        altText: m.alt ?? '',
        caption: '',
        title: '',
        tags: [],
        width: m.width ?? null,
        height: m.height ?? null,
        durationMs: null,
        dominantColor: null,
        blurHash: null,
        storagePath: m.path.replace('/uploads/', ''),
        posterPath: null,
        folderIds: [],
        bytesBase64: btoa(new TextDecoder().decode(mediaBytesFor(m.id))),
      })),
    }
  }

  it('extracts the same closure from a site-transfer bundle', async () => {
    const fromBundle = await extractFragment(fragmentSourceFromBundle(bundle()), { pageId: 'page-home', rootNodeIds: ['hero'] })
    const fromSite = await extractFragment(source(), { pageId: 'page-home', rootNodeIds: ['hero'] })
    expect(fromBundle.fragment.styleRules.map((r) => r.id)).toEqual(fromSite.fragment.styleRules.map((r) => r.id))
    expect(fromBundle.fragment.components.map((c) => c.id).sort()).toEqual(['vc-badge', 'vc-card'])
    expect(fromBundle.fragment.tables.map((t) => t.slug).sort()).toEqual(['contact', 'projects'])
    expect(fromBundle.fragment.media.map((m) => m.key).sort()).toEqual(fromSite.fragment.media.map((m) => m.key).sort())
  })
})

describe('fragment packages', () => {
  it('round-trips a fragment and its media through a zip', async () => {
    const { fragment, mediaBytes } = await extractFragment(source(), { pageId: 'page-home', rootNodeIds: ['hero'] })
    const pkg = readFragmentPackage(writeFragmentPackage(fragment, mediaBytes))
    expect(pkg.fragment).toEqual(fragment)
    const photo = fragment.media.find((m) => m.id === 'media-photo')!
    expect(pkg.readMedia(photo)).toEqual(mediaBytesFor('media-photo'))
  })
})
