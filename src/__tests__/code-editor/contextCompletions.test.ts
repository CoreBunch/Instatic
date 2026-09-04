/**
 * The God Mode context completion sources over real CodeMirror language
 * states: instatic tags/attributes/values, class names, published-site
 * custom properties, dynamic tokens with entry-frame resolution, and page
 * selectors in scripts — each APPENDED to the language's default source,
 * which keeps working alongside.
 */
import { describe, expect, it } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { javascript } from '@codemirror/lang-javascript'
import type { Extension } from '@codemirror/state'
import { contextCompletions } from '@site/code-editor/contextCompletions'
import type {
  CssCompletionCatalog,
  EditorCompletionCatalog,
  HtmlCompletionCatalog,
  JsCompletionCatalog,
} from '@site/code-editor/completionCatalog'

const htmlCatalog: HtmlCompletionCatalog = {
  kind: 'html',
  classes: [
    { name: 'card', usage: 2, generated: false },
    { name: 'text-m', usage: 5, generated: true },
  ],
  components: [{ id: 'vc-hero', name: 'Hero' }],
  tokens: {
    systemSources: [
      { id: 'page', label: 'Page', fields: [{ id: 'title', label: 'Page title' }, { id: 'slug', label: 'Slug' }] },
      { id: 'site', label: 'Site', fields: [{ id: 'name', label: 'Site name' }] },
      { id: 'route', label: 'Route', fields: [{ id: 'path', label: 'Path' }] },
    ],
    loopSources: {
      'data.rows': { label: 'Data rows', fields: [{ id: 'permalink', label: 'Permalink' }, { id: 'body', label: 'Body' }] },
      'site.pages': { label: 'Site pages', fields: [{ id: 'title', label: 'Title' }, { id: 'permalink', label: 'Permalink' }] },
    },
    tables: [
      { id: 'tbl-posts', slug: 'posts', name: 'Posts', kind: 'postType', fields: [{ id: 'title', label: 'Title' }, { id: 'excerpt', label: 'Excerpt' }] },
    ],
    outerEntries: [],
  },
}

const cssCatalog: CssCompletionCatalog = {
  kind: 'css',
  classes: [{ name: 'card', usage: 2, generated: false }, { name: 'hero', usage: 0, generated: false }],
  customProperties: [
    { name: '--primary', value: '#0000ff', origin: 'framework', declaredIn: 'Framework · colors' },
    { name: '--space-m', value: 'clamp(1rem, 2vw, 2rem)', origin: 'framework', declaredIn: 'Framework · spacing' },
    { name: '--card-pad', value: '12px', origin: 'rule', declaredIn: '.card' },
    { name: '--brand', value: '#123456', origin: 'asset', declaredIn: 'src/styles/main.css' },
  ],
}

const jsCatalog: JsCompletionCatalog = {
  kind: 'js',
  classes: ['hero', 'card', 'btn'],
  ids: ['intro', 'main'],
  selectedClasses: ['hero'],
  selectedIds: ['intro'],
}

function language(kind: EditorCompletionCatalog['kind']): Extension {
  return kind === 'html' ? html() : kind === 'css' ? css() : javascript()
}

/** Run every completion source active at the cursor (defaults + context) and merge their options. */
async function complete(
  catalog: EditorCompletionCatalog,
  doc: string,
  options: { explicit?: boolean } = {},
): Promise<{ results: CompletionResult[]; labels: string[] }> {
  const cursor = doc.indexOf('|')
  const text = doc.replace('|', '')
  const pos = cursor >= 0 ? cursor : text.length
  const state = EditorState.create({ doc: text, extensions: [language(catalog.kind), contextCompletions(() => catalog)] })
  const sources = state.languageDataAt<CompletionSource>('autocomplete', pos)
  const context = new CompletionContext(state, pos, options.explicit ?? false)
  const results: CompletionResult[] = []
  for (const source of sources) {
    const result = await source(context)
    if (result) results.push(result)
  }
  return { results, labels: results.flatMap((r) => r.options.map((o) => o.label)) }
}

function resultWith(results: CompletionResult[], label: string): CompletionResult {
  const result = results.find((r) => r.options.some((o) => o.label === label))
  expect(result).toBeDefined()
  return result!
}

describe('HTML context completions', () => {
  it('offers the instatic marker tags alongside the standard tags', async () => {
    const { labels, results } = await complete(htmlCatalog, '<div><inst|')
    expect(labels).toContain('instatic-loop')
    expect(labels).toContain('instatic-component')
    expect(labels).toContain('instatic-slot')
    expect(labels).toContain('instatic-slot-outlet')
    expect(labels).toContain('instatic-outlet')
    expect(labels).toContain('div')
    expect(resultWith(results, 'instatic-loop').from).toBe(6)
  })

  it('offers a marker tag attributes inside it, next to the global attributes', async () => {
    const { labels } = await complete(htmlCatalog, '<instatic-loop data-|')
    expect(labels).toContain('data-source-id')
    expect(labels).toContain('data-table-id')
    expect(labels).toContain('data-pagination')
    expect(labels).toContain('class')
    expect(labels).not.toContain('data-slot-name')
    const slot = await complete(htmlCatalog, '<instatic-slot |')
    expect(slot.labels).toContain('data-slot-name')
    expect(slot.labels).not.toContain('data-source-id')
    const plain = await complete(htmlCatalog, '<div |')
    expect(plain.labels).not.toContain('data-source-id')
  })

  it('completes dialect attribute values: loop sources, tables, components, keywords', async () => {
    const { results } = await complete(htmlCatalog, '<instatic-loop data-source-id="|')
    const source = resultWith(results, 'data.rows')
    expect(source.options.find((o) => o.label === 'data.rows')?.apply).toBe('data.rows"')
    expect(source.options.find((o) => o.label === 'site.pages')?.detail).toBe('Site pages')
    expect((await complete(htmlCatalog, '<instatic-loop data-table-id="tbl|')).labels).toContain('tbl-posts')
    expect((await complete(htmlCatalog, '<instatic-component data-component-id="|')).labels).toContain('vc-hero')
    expect((await complete(htmlCatalog, '<instatic-loop data-direction="|')).labels).toEqual(expect.arrayContaining(['asc', 'desc']))
    const closed = await complete(htmlCatalog, '<instatic-loop data-pagination="|">')
    expect(resultWith(closed.results, 'infinite').options[0].apply).toBe('infinite')
  })

  it('completes class names one word at a time inside a class attribute, framework utilities included', async () => {
    const { results } = await complete(htmlCatalog, '<div class="hero ca|"')
    const classes = resultWith(results, 'card')
    expect(classes.from).toBe('<div class="hero '.length)
    expect(classes.options.map((o) => o.label)).toEqual(['card', 'text-m'])
    expect(classes.options[1]).toMatchObject({ detail: 'framework utility', boost: -1 })
    expect(classes.options[0]).toMatchObject({ detail: 'used by 2', boost: 0 })
  })

  it('completes non-entry token sources outside any loop, in text and attribute values', async () => {
    const text = await complete(htmlCatalog, '<p>Hello {|')
    expect(text.labels).toEqual(expect.arrayContaining(['page.title', 'page.slug', 'site.name', 'route.path']))
    expect(text.labels.some((l) => l.startsWith('currentEntry.'))).toBe(false)
    expect(text.labels.some((l) => l.startsWith('parentEntry.'))).toBe(false)
    const token = resultWith(text.results, 'site.name')
    expect(token.from).toBe('<p>Hello {'.length)
    expect(token.options.find((o) => o.label === 'site.name')?.apply).toBe('site.name}')

    const attribute = await complete(htmlCatalog, '<a title="See {pa|">')
    expect(attribute.labels).toContain('page.title')
    expect(resultWith(attribute.results, 'page.title').from).toBe('<a title="See {'.length)
  })

  it('does not treat an escaped brace, a closed token, or a space as a token start', async () => {
    expect((await complete(htmlCatalog, '<p>\\{no|')).labels).not.toContain('site.name')
    expect((await complete(htmlCatalog, '<p>{site.name} no|')).labels).not.toContain('site.name')
    expect((await complete(htmlCatalog, '<p>{site name|')).labels).not.toContain('site.name')
  })

  it('completes currentEntry fields from the enclosing loop written in the text, from its actual source schema', async () => {
    const doc = '<instatic-loop data-source-id="data.rows" data-table-id="tbl-posts"><h2>{cur|</h2></instatic-loop>'
    const { results, labels } = await complete(htmlCatalog, doc)
    expect(labels).toContain('currentEntry.title')
    expect(labels).toContain('currentEntry.excerpt')
    expect(labels).toContain('currentEntry.permalink')
    expect(labels).toContain('currentEntry.body')
    expect(labels).toContain('page.title')
    expect(labels.some((l) => l.startsWith('parentEntry.'))).toBe(false)
    const entry = resultWith(results, 'currentEntry.title').options.find((o) => o.label === 'currentEntry.title')!
    expect(entry.section).toBe('Current entry')
    expect(entry.detail).toBe('Title')

    const pages = await complete(htmlCatalog, '<instatic-loop data-source-id="site.pages"><p>{|</p></instatic-loop>')
    expect(pages.labels).toContain('currentEntry.title')
    expect(pages.labels).toContain('currentEntry.permalink')
    expect(pages.labels).not.toContain('currentEntry.excerpt')
  })

  it('resolves parentEntry from the outer loop, in the text or from the catalog outer frames', async () => {
    const nested = '<instatic-loop data-source-id="site.pages"><instatic-loop data-source-id="data.rows" data-table-id="tbl-posts"><p>{|</p></instatic-loop></instatic-loop>'
    const { labels } = await complete(htmlCatalog, nested)
    expect(labels).toContain('currentEntry.excerpt')
    expect(labels).toContain('parentEntry.title')
    expect(labels).not.toContain('parentEntry.excerpt')

    const scoped: HtmlCompletionCatalog = {
      ...htmlCatalog,
      tokens: { ...htmlCatalog.tokens, outerEntries: [{ kind: 'loop', sourceId: 'site.pages', tableId: null }] },
    }
    const outside = await complete(scoped, '<p>{|</p>')
    expect(outside.labels).toContain('currentEntry.permalink')
    expect(outside.labels).not.toContain('parentEntry.permalink')
    const inside = await complete(scoped, '<instatic-loop data-source-id="data.rows" data-table-id="tbl-posts"><p>{|</p></instatic-loop>')
    expect(inside.labels).toContain('currentEntry.excerpt')
    expect(inside.labels).toContain('parentEntry.title')
  })

  it('keeps lang-html defaults working: tags, attributes, and closing tags', async () => {
    expect((await complete(htmlCatalog, '<di|')).labels).toContain('div')
    expect((await complete(htmlCatalog, '<div cl|')).labels).toContain('class')
    expect((await complete(htmlCatalog, '<div></|')).labels).toContain('div')
  })
})

describe('CSS context completions', () => {
  it('lists the published-site custom properties inside var(), grouped by origin, without editor tokens', async () => {
    for (const doc of ['.card { color: var(|', '.card { color: var(-|', '.card { color: var(--|', '.card { color: var(--pr|) }']) {
      const { results, labels } = await complete(cssCatalog, doc)
      expect(labels).toEqual(expect.arrayContaining(['--primary', '--space-m', '--card-pad', '--brand']))
      expect(labels.some((l) => l.startsWith('--editor-'))).toBe(false)
      const result = resultWith(results, '--primary')
      expect(result.from).toBe(doc.indexOf('|') - (doc.slice(doc.indexOf('var(') + 4, doc.indexOf('|')).length))
      const primary = result.options.find((o) => o.label === '--primary')!
      expect(primary.section).toBe('Framework tokens')
      expect(primary.detail).toBe('#0000ff')
      expect(result.options.find((o) => o.label === '--card-pad')?.section).toBe('Style rules')
      expect(result.options.find((o) => o.label === '--brand')?.section).toBe('Style assets')
    }
  })

  it('leaves properties the document itself declares to the default source', async () => {
    const { results } = await complete(cssCatalog, ':root { --card-pad: 4px; }\n.card { padding: var(--|')
    const all = results.flatMap((r) => r.options.filter((o) => o.label === '--card-pad'))
    expect(all).toHaveLength(1)
    expect(results.some((r) => r.options.some((o) => o.label === '--primary'))).toBe(true)
  })

  it('offers no custom properties outside var()', async () => {
    const { labels } = await complete(cssCatalog, '.card { color: |')
    expect(labels).not.toContain('--primary')
  })

  it('completes editable class names after a dot in a selector', async () => {
    const typed = await complete(cssCatalog, '.card, .he|')
    const result = resultWith(typed.results, 'hero')
    expect(result.from).toBe('.card, .'.length)
    expect(result.options.map((o) => o.label)).toEqual(['card', 'hero'])
    expect(result.options[0].detail).toBe('used by 2')
    const bare = await complete(cssCatalog, '.card .|')
    expect(resultWith(bare.results, 'hero').from).toBe('.card .'.length)
    const inBlock = await complete(cssCatalog, '.card { content: ".|')
    expect(inBlock.labels).not.toContain('hero')
  })

  it('keeps lang-css defaults working: values and pseudo-classes', async () => {
    // (lang-css lists property names from `document.body.style`, which the
    // test DOM leaves empty — its static lists stand in for the default source.)
    expect((await complete(cssCatalog, '.card { display: fl|')).labels).toContain('flex')
    expect((await complete(cssCatalog, '.card:ho|')).labels).toContain('hover')
  })
})

describe('JS context completions', () => {
  it('completes .class and #id tokens inside selector strings, selected element first', async () => {
    const { results } = await complete(jsCatalog, "document.querySelector('.|')")
    const result = resultWith(results, 'hero')
    expect(result.options.map((o) => o.label)).toEqual(['hero', 'card', 'btn'])
    expect(result.options[0]).toMatchObject({ section: 'Selected element', boost: 1 })
    expect(result.options[1]).toMatchObject({ section: 'Page', boost: 0 })
    expect(result.from).toBe("document.querySelector('.".length)

    const ids = await complete(jsCatalog, 'el.closest("#ma|")')
    expect(resultWith(ids.results, 'main').options.map((o) => o.label)).toEqual(['intro', 'main'])

    const both = await complete(jsCatalog, 'document.querySelectorAll(`.card > |`)')
    expect(both.labels).toEqual(expect.arrayContaining(['.hero', '#intro']))
    expect(resultWith(both.results, '.hero').from).toBe('document.querySelectorAll(`.card > '.length)
  })

  it('completes bare class names for classList and getElementsByClassName, bare ids for getElementById', async () => {
    expect((await complete(jsCatalog, "el.classList.add('he|')")).labels).toEqual(expect.arrayContaining(['hero', 'card']))
    expect((await complete(jsCatalog, "el.classList.add('|')")).labels).not.toContain('.hero')
    expect((await complete(jsCatalog, "document.getElementsByClassName('|')")).labels).toContain('btn')
    const byId = await complete(jsCatalog, "document.getElementById('|')")
    expect(byId.labels).toEqual(expect.arrayContaining(['intro', 'main']))
    expect(byId.labels).not.toContain('hero')
  })

  it('stays quiet in unrelated strings and outside strings', async () => {
    expect((await complete(jsCatalog, "console.log('.|')")).labels).not.toContain('hero')
    expect((await complete(jsCatalog, "other.contains('|')")).labels).not.toContain('hero')
    expect((await complete(jsCatalog, 'const hero = .|')).labels).not.toContain('hero')
  })

  it('keeps lang-javascript defaults working: keywords and local names', async () => {
    const { labels } = await complete(jsCatalog, 'const total = 1;\nfunc|')
    expect(labels).toContain('function')
    const local = await complete(jsCatalog, 'const total = 1;\nto|')
    expect(local.labels).toContain('total')
  })
})
