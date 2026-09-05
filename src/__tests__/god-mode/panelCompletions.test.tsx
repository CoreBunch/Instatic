/**
 * The Code Dock panels over real CodeMirror, completing from the editor
 * store: the HTML panel's tokens resolve the enclosing loop's table schema
 * (loaded meta) and classes; the CSS panel's var() lists site properties
 * beyond the projected sheet; the JS panel's selector strings list the
 * page's classes with the selected element first.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { CompletionContext, type CompletionSource } from '@codemirror/autocomplete'
import { useEditorStore } from '@site/store/store'
import { HtmlPanel } from '@site/code-dock/html'
import { CssPanel } from '@site/code-dock/css'
import { JsPanel } from '@site/code-dock/js'
import { clearDataMetaCache } from '@admin/shared/DataBindingPicker/cache'
import '@modules/base/index'
import '@core/loops/sources'

const originalFetch = globalThis.fetch
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

const meta = {
  tables: [
    {
      id: 'tbl-posts',
      slug: 'posts',
      name: 'Posts',
      kind: 'postType',
      singularLabel: 'Post',
      pluralLabel: 'Posts',
      primaryFieldId: 'title',
      routable: true,
      versioned: true,
      fields: [{ id: 'title', label: 'Title', type: 'text' }, { id: 'excerpt', label: 'Excerpt', type: 'longText' }],
    },
  ],
}

beforeAll(() => {
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === '/admin/api/cms/data/_meta') {
      return new Response(JSON.stringify({ meta }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 })
  }
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

function state() {
  return useEditorStore.getState()
}

function setup() {
  clearDataMetaCache()
  state().clearSite()
  useEditorStore.setState({
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeDocument: null,
    activeClassId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
  const site = state().createSite('Completions')
  const rootId = site.pages[0].rootNodeId
  const card = state().createClass('card', { color: 'red' })
  state().createClass('hero', { '--hero-gap': '2rem' })
  const loopId = state().insertNode('base.loop', { sourceId: 'data.rows', filters: { tableId: 'tbl-posts' } }, rootId)
  const inLoop = state().insertNode('base.text', {}, loopId)
  const outside = state().insertNode('base.text', {}, rootId)
  state().addNodeClass(outside, card.id)
  return { rootId, loopId, inLoop, outside }
}

async function mountedView(element: React.ReactElement): Promise<EditorView> {
  render(element)
  await waitFor(() => expect(document.querySelector('.cm-editor')).toBeTruthy())
  await nextFrame()
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)
  expect(view).toBeTruthy()
  return view!
}

async function completeAt(view: EditorView, pos: number): Promise<string[]> {
  const sources = view.state.languageDataAt<CompletionSource>('autocomplete', pos)
  const context = new CompletionContext(view.state, pos, false)
  const labels: string[] = []
  for (const source of sources) {
    const result = await source(context)
    if (result) labels.push(...result.options.map((o) => o.label))
  }
  return labels
}

function append(view: EditorView, text: string): number {
  const at = view.state.doc.length
  act(() => {
    view.dispatch({ changes: { from: at, insert: text } })
  })
  return at + text.length
}

beforeEach(setup)
afterEach(cleanup)

describe('Code Dock completions', () => {
  it('HTML panel: tokens inside a selected loop item resolve the table schema; classes complete in class attributes', async () => {
    const { inLoop } = setup()
    state().selectNode(inLoop)
    const view = await mountedView(<HtmlPanel />)
    // Wait for the meta to load into the catalog (the panel re-renders with it).
    await waitFor(async () => {
      const pos = append(view, '<p>{')
      const labels = await completeAt(view, pos)
      expect(labels).toContain('currentEntry.excerpt')
      expect(labels).toContain('currentEntry.permalink')
      expect(labels).toContain('page.title')
    })
    const pos = append(view, '</p><div class="')
    const labels = await completeAt(view, pos)
    expect(labels).toEqual(expect.arrayContaining(['card', 'hero']))
  })

  it('HTML panel: outside any loop only the non-entry sources are offered, and marker tags complete', async () => {
    const { outside } = setup()
    state().selectNode(outside)
    const view = await mountedView(<HtmlPanel />)
    const pos = append(view, '<p>{')
    const labels = await completeAt(view, pos)
    expect(labels).toContain('site.name')
    expect(labels.some((l) => l.startsWith('currentEntry.'))).toBe(false)
    const tagPos = append(view, '</p><inst')
    expect(await completeAt(view, tagPos)).toContain('instatic-loop')
  })

  it('CSS panel: var() lists site properties beyond the projected sheet, and selectors complete classes', async () => {
    const { outside } = setup()
    state().selectNode(outside)
    const view = await mountedView(<CssPanel />)
    const doc = view.state.doc.toString()
    expect(doc).toContain('.card {')
    expect(doc).not.toContain('--hero-gap')
    const pos = append(view, '\n.card { padding: var(--')
    const labels = await completeAt(view, pos)
    expect(labels).toContain('--hero-gap')
    expect(labels.some((l) => l.startsWith('--editor-'))).toBe(false)
    const selectorPos = append(view, ') }\n.')
    expect(await completeAt(view, selectorPos)).toEqual(expect.arrayContaining(['card', 'hero']))
  })

  it('JS panel: selector strings complete the page classes, the selected element first', async () => {
    const { outside } = setup()
    state().selectNode(outside)
    const view = await mountedView(<JsPanel />)
    const pos = append(view, "document.querySelector('.")
    const sources = view.state.languageDataAt<CompletionSource>('autocomplete', pos)
    const context = new CompletionContext(view.state, pos, false)
    const results = (await Promise.all(sources.map((source) => source(context)))).filter((r) => r !== null)
    const selectors = results.find((r) => r.options.some((o) => o.label === 'card'))
    expect(selectors).toBeDefined()
    expect(selectors!.options[0]).toMatchObject({ label: 'card', section: 'Selected element' })
  })
})
