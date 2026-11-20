import { describe, expect, it } from 'bun:test'
import { makeModule, makePage, makeRegistry, makeSite } from '../publisher/helpers'
import { publishPage } from '@core/publisher'
import { resolveDynamicProps } from '@core/templates/dynamicBindings'
import type { LoopItem } from '@core/loops/types'
import { OutletModule } from '@modules/base/outlet'

const currentEntry: LoopItem = {
  id: 'version_1',
  fields: {
    id: 'version_1',
    entryId: 'entry_1',
    collectionId: 'posts',
    collectionSlug: 'posts',
    collectionRouteBase: '/posts',
    versionNumber: 1,
    title: 'Dynamic Post',
    slug: 'dynamic-post',
    body: '## Heading\n\nBody text',
    bodyMarkdown: '## Heading\n\nBody text',
    featuredMediaId: 'media_1',
    featuredMedia: '/uploads/cover.jpg',
    featuredMediaPath: '/uploads/cover.jpg',
    featuredMediaUrl: '/uploads/cover.jpg',
    firstImage: null,
    firstImagePath: null,
    firstImageUrl: null,
    seoTitle: 'SEO title',
    seoDescription: 'SEO description',
    publishedAt: '2026-05-01T10:00:00.000Z',
    createdAt: '2026-05-01T10:00:00.000Z',
  },
}

describe('dynamic template rendering', () => {
  it('overlays current entry fields over static props', () => {
    const props = resolveDynamicProps(
      { text: 'Static fallback' },
      { text: { source: 'currentEntry', field: 'title' } },
      { entryStack: [currentEntry] },
    )

    expect(props.text).toBe('Dynamic Post')
  })

  it('keeps the static fallback when a binding cannot resolve', () => {
    const props = resolveDynamicProps(
      { text: 'Static fallback' },
      { text: { source: 'currentEntry', field: 'missing' } },
      { entryStack: [currentEntry] },
    )

    expect(props.text).toBe('Static fallback')
  })

  it('resolves featured media paths for media bindings', () => {
    const props = resolveDynamicProps(
      { src: '' },
      { src: { source: 'currentEntry', field: 'featuredMedia', format: 'media' } },
      { entryStack: [currentEntry] },
    )

    expect(props.src).toBe('/uploads/cover.jpg')
  })

  it('resolves the first inline body image for media bindings', () => {
    const itemWithBodyImage: LoopItem = {
      ...currentEntry,
      fields: {
        ...currentEntry.fields,
        bodyMarkdown: 'Intro\n\n![Hero](/uploads/body-hero.jpg)\n\n![Other](/uploads/other.jpg)',
        firstImage: '/uploads/body-hero.jpg',
        firstImagePath: '/uploads/body-hero.jpg',
        firstImageUrl: '/uploads/body-hero.jpg',
      },
    }
    const props = resolveDynamicProps(
      { src: '' },
      { src: { source: 'currentEntry', field: 'firstImage', format: 'media' } },
      { entryStack: [itemWithBodyImage] },
    )

    expect(props.src).toBe('/uploads/body-hero.jpg')
  })

  it('translates a bare media reference (custom media cell id) through the context media lookup', () => {
    const itemWithCustomMediaCell: LoopItem = {
      ...currentEntry,
      fields: { ...currentEntry.fields, thumbnail: 'asset_123' },
    }
    const props = resolveDynamicProps(
      { src: '' },
      { src: { source: 'currentEntry', field: 'thumbnail', format: 'media' } },
      {
        entryStack: [itemWithCustomMediaCell],
        media: new Map([['asset_123', { publicPath: '/uploads/thumb.jpg' }]]),
      },
    )

    expect(props.src).toBe('/uploads/thumb.jpg')
  })

  it('keeps the static fallback when a media reference cannot be resolved', () => {
    const itemWithCustomMediaCell: LoopItem = {
      ...currentEntry,
      fields: { ...currentEntry.fields, thumbnail: 'asset_deleted' },
    }
    // No media lookup on the context (and the id is not a path) — the raw id
    // must never leak into the prop; the static value wins instead.
    const props = resolveDynamicProps(
      { src: '/placeholder.png' },
      { src: { source: 'currentEntry', field: 'thumbnail', format: 'media' } },
      { entryStack: [itemWithCustomMediaCell] },
    )

    expect(props.src).toBe('/placeholder.png')
  })

  it('passes external URLs in media bindings through without a lookup', () => {
    const itemWithExternalUrl: LoopItem = {
      ...currentEntry,
      fields: { ...currentEntry.fields, thumbnail: 'https://cdn.example.com/thumb.jpg' },
    }
    const props = resolveDynamicProps(
      { src: '' },
      { src: { source: 'currentEntry', field: 'thumbnail', format: 'media' } },
      { entryStack: [itemWithExternalUrl], media: new Map() },
    )

    expect(props.src).toBe('https://cdn.example.com/thumb.jpg')
  })

  it('resolves parentEntry from the frame below the stack top', () => {
    const outer: LoopItem = {
      id: 'outer',
      fields: { title: 'Outer Post' },
    }
    const inner: LoopItem = {
      id: 'inner',
      fields: { title: 'Inner Post' },
    }
    const props = resolveDynamicProps(
      { text: '', parentText: '' },
      {
        text: { source: 'currentEntry', field: 'title' },
        parentText: { source: 'parentEntry', field: 'title' },
      },
      { entryStack: [outer, inner] },
    )

    expect(props.text).toBe('Inner Post')
    expect(props.parentText).toBe('Outer Post')
  })

  it('renders dynamic values through publishPage while static pages stay unchanged', () => {
    const textModule = makeModule('base.text', {
      render: (props) => ({
        html: `<p>${String((props as { text: string }).text)}</p>`,
      }),
    })
    const registry = makeRegistry({
      'base.body': makeModule('base.body', {
        canHaveChildren: true,
        render: (_props, children) => ({ html: `<main>${children.join('')}</main>` }),
      }),
      'base.text': textModule,
      'base.outlet': OutletModule,
    })
    const site = makeSite()
    const page = makePage({
      root: { moduleId: 'base.body', props: {}, children: ['title', 'body'] },
      title: {
        moduleId: 'base.text',
        props: { text: 'Static title' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
      body: {
        moduleId: 'base.outlet',
        props: { html: '<p>Static body</p>' },
        dynamicBindings: { html: { source: 'currentEntry', field: 'body', format: 'html' } },
      },
    })

    const dynamicHtml = publishPage(page, site, registry, {
      templateContext: { entryStack: [currentEntry] },
    }).html
    const staticHtml = publishPage(page, site, registry).html

    expect(dynamicHtml).toContain('<p>Dynamic Post</p>')
    expect(dynamicHtml).toContain('<h2>Heading</h2>')
    expect(dynamicHtml).toContain('<p>Body text</p>')
    expect(staticHtml).toContain('<p>Static title</p>')
    expect(staticHtml).toContain('<p>Static body</p>')
  })

  it('lets a persisted outlet html binding win over the implicit body binding', () => {
    // A custom data table stores its content in a `rich-text` cell instead of
    // `body`. A persisted binding on the outlet must beat the implicit
    // `currentEntry.body` default so the outlet can render ANY rich field.
    const registry = makeRegistry({
      'base.body': makeModule('base.body', {
        canHaveChildren: true,
        render: (_props, children) => ({ html: `<main>${children.join('')}</main>` }),
      }),
      'base.outlet': OutletModule,
    })
    const itemWithCustomRichCell: LoopItem = {
      ...currentEntry,
      fields: {
        ...currentEntry.fields,
        body: 'BODY CELL — must not render',
        'rich-text': '## Custom heading\n\nCustom cell content',
      },
    }
    const page = makePage({
      root: { moduleId: 'base.body', props: {}, children: ['outlet'] },
      outlet: {
        moduleId: 'base.outlet',
        props: {},
        dynamicBindings: {
          html: { source: 'currentEntry', field: 'rich-text', format: 'html' },
        },
      },
    })

    const { html } = publishPage(page, makeSite(), registry, {
      templateContext: { entryStack: [itemWithCustomRichCell] },
    })

    expect(html).toContain('<h2>Custom heading</h2>')
    expect(html).toContain('Custom cell content')
    expect(html).not.toContain('must not render')
  })

  it('renders markdown for a custom rich field bound with format html into a richtext prop', () => {
    const itemWithCustomRichCell: LoopItem = {
      ...currentEntry,
      fields: { ...currentEntry.fields, excerpt: '**Bold** intro' },
    }
    const props = resolveDynamicProps(
      { html: '' },
      { html: { source: 'currentEntry', field: 'excerpt', format: 'html' } },
      { entryStack: [itemWithCustomRichCell] },
    )

    expect(props.html).toContain('<strong>Bold</strong>')
  })

  it('passes HTML-stored custom rich cells through the markdown render unchanged', () => {
    // richText fields with `format: 'html'` storage hold HTML, not markdown.
    // Block HTML survives the GFM renderer verbatim, so the same binding path
    // serves both storage formats.
    const itemWithHtmlCell: LoopItem = {
      ...currentEntry,
      fields: { ...currentEntry.fields, 'rich-text': '<p>First</p><h2>Section</h2>' },
    }
    const props = resolveDynamicProps(
      { html: '' },
      { html: { source: 'currentEntry', field: 'rich-text', format: 'html' } },
      { entryStack: [itemWithHtmlCell] },
    )

    expect(props.html).toContain('<p>First</p>')
    expect(props.html).toContain('<h2>Section</h2>')
  })

  it('publishes a bound custom media cell as the asset URL through publishPage', () => {
    const imageModule = makeModule('test.image', {
      schema: { src: { type: 'image', label: 'Image' } },
      render: (props) => ({
        html: `<img src="${String((props as { src?: string }).src ?? '')}">`,
      }),
    })
    const registry = makeRegistry({
      'base.body': makeModule('base.body', {
        canHaveChildren: true,
        render: (_props, children) => ({ html: `<main>${children.join('')}</main>` }),
      }),
      'test.image': imageModule,
    })
    const itemWithCustomMediaCell: LoopItem = {
      ...currentEntry,
      fields: { ...currentEntry.fields, thumbnail: 'asset_123' },
    }
    const page = makePage({
      root: { moduleId: 'base.body', props: {}, children: ['img'] },
      img: {
        moduleId: 'test.image',
        props: { src: '' },
        dynamicBindings: {
          src: { source: 'currentEntry', field: 'thumbnail', format: 'media' },
        },
      },
    })

    const { html } = publishPage(page, makeSite(), registry, {
      templateContext: { entryStack: [itemWithCustomMediaCell] },
      mediaAssets: new Map([
        [
          'asset_123',
          {
            publicPath: '/uploads/thumb.jpg',
            mimeType: 'image/jpeg',
            width: 800,
            height: 600,
            altText: 'Thumb',
            blurHash: null,
            variants: [],
            posterPath: null,
          },
        ],
      ]),
    })

    expect(html).toContain('<img src="/uploads/thumb.jpg">')
    expect(html).not.toContain('asset_123')
  })

  it('renders markdown when a token resolves into a richtext-typed prop', () => {
    // Legacy template shape (still used in dev DBs): the `base.outlet`
    // node carries a static `html: "{currentEntry.body}"` prop and no
    // `dynamicBindings`. Token interpolation drops the raw markdown body
    // into the richtext prop; the renderer must run it through the
    // markdown pipeline so the published page emits real HTML instead of
    // raw `##` markers.
    const props = resolveDynamicProps(
      { html: '{currentEntry.body}' },
      undefined,
      { entryStack: [currentEntry] },
    )

    expect(props.html).toContain('<h2>Heading</h2>')
    expect(props.html).toContain('<p>Body text</p>')
    expect(props.html).not.toContain('##')
  })

  it('renders markdown for a custom richtext-suffixed prop key', () => {
    const props = resolveDynamicProps(
      { bodyHtml: '{currentEntry.body}' },
      undefined,
      { entryStack: [currentEntry] },
    )

    expect(props.bodyHtml).toContain('<h2>Heading</h2>')
  })

  it('leaves non-richtext token interpolations as plain strings', () => {
    const props = resolveDynamicProps(
      { text: '{currentEntry.title}', label: '{currentEntry.title}' },
      undefined,
      { entryStack: [currentEntry] },
    )

    // No <p> wrapper around the title — these props are not richtext.
    expect(props.text).toBe('Dynamic Post')
    expect(props.label).toBe('Dynamic Post')
  })

  it('passes through HTML stored in the body cell unchanged via markdown render', () => {
    // Seeded demo posts store HTML directly in the body cell. Marked is
    // GFM-safe — block HTML passes through, so the richtext-token path
    // doesn't break entries that pre-date the markdown editor.
    const itemWithHtmlBody: LoopItem = {
      ...currentEntry,
      fields: {
        ...currentEntry.fields,
        body: '<p>First paragraph</p><h2>Section</h2><p>Second paragraph</p>',
      },
    }
    const props = resolveDynamicProps(
      { html: '{currentEntry.body}' },
      undefined,
      { entryStack: [itemWithHtmlBody] },
    )

    expect(props.html).toContain('<p>First paragraph</p>')
    expect(props.html).toContain('<h2>Section</h2>')
    expect(props.html).toContain('<p>Second paragraph</p>')
  })
})
