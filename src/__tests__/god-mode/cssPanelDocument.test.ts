/**
 * deriveCssPanelDocument — which CSS the God Mode CSS panel shows for the
 * current selection (or the whole page), and how each block is annotated.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { deriveCssPanelDocument } from '@site/code-dock/css/cssPanelDocument'
import '@modules/base/index'

function state() {
  return useEditorStore.getState()
}

const canvas = {
  findNodeElement: (nodeId: string) =>
    document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`),
}

function setup() {
  state().clearSite()
  useEditorStore.setState({
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeDocument: null,
    activeClassId: null,
  } as Parameters<typeof useEditorStore.setState>[0])

  const site = state().createSite('CSS panel')
  const page = site.pages[0]
  const rootId = page.rootNodeId
  const headingId = state().insertNode('base.text', {}, rootId)
  const paragraphId = state().insertNode('base.text', {}, rootId)
  const card = state().createClass('card', { color: 'red' })
  state().addNodeClass(headingId, card.id)
  state().addNodeClass(paragraphId, card.id)
  useEditorStore.setState((s) => {
    s.site!.styleRules['gen-text-m'] = {
      id: 'gen-text-m',
      name: 'text-m',
      kind: 'class',
      selector: '.text-m',
      order: 50,
      styles: { fontSize: 'var(--text-m)' },
      contextStyles: {},
      generated: { origin: 'framework', family: 'typography', sourceId: 'body', generatorId: 'g', tokenName: 'text', step: 'm', locked: true },
      createdAt: 1,
      updatedAt: 1,
    }
  })
  state().addNodeClass(headingId, 'gen-text-m')
  const h1Rule = state().createAmbientRule({ selector: 'h1', styles: { fontWeight: '700' } })
  const pRule = state().createAmbientRule({ selector: 'p', styles: { margin: '0' } })
  const resetRule = state().createAmbientRule({ selector: '*', styles: { boxSizing: 'border-box' } })
  state().createAmbientRule({ selector: 'nav a', styles: { color: 'blue' } })
  state().setNodeInlineStyles(headingId, { marginTop: '4px' })

  document.body.innerHTML = [
    `<div data-node-id="${rootId}">`,
    `<h1 data-node-id="${headingId}" class="card text-m">Title</h1>`,
    `<p data-node-id="${paragraphId}" class="card">Body</p>`,
    '</div>',
  ].join('')

  return { pageId: page.id, rootId, headingId, paragraphId, cardId: card.id, h1Rule, pRule, resetRule }
}

beforeEach(setup)
// The rendered-canvas fixture lives in document.body, which Testing Library
// also renders into: left behind, its "Title" heading turned a later suite's
// getByText('Title') into "Found multiple elements". The store is the shared
// singleton every suite reads, so the site goes too.
afterEach(() => {
  document.body.innerHTML = ''
  state().clearSite()
})

describe('deriveCssPanelDocument', () => {
  it('scopes to the selected element: its classes, matching ambient rules, inline styles, framework utilities last', () => {
    const { headingId, cardId, h1Rule } = setup()
    state().selectNode(headingId)

    const doc = deriveCssPanelDocument(state(), canvas)!
    expect(doc.docKey).toBe(`css:node:${headingId}`)
    expect(doc.projection.blocks.map((b) => [b.origin, b.ruleId ?? b.nodeId])).toEqual([
      ['class', cardId],
      ['ambient', h1Rule.id],
      ['inline', headingId],
      ['framework', 'gen-text-m'],
    ])
    expect(doc.projection.text).toContain('/* .card · class · used by 2 elements */')
    expect(doc.projection.text).toContain('/* h1 · ambient rule · matches 1 element on this page */')
    expect(doc.projection.text).toContain('element {\n  margin-top: 4px;\n}')
    expect(doc.projection.text).toContain('/* .text-m · framework utility · read-only · used by 1 element */')
  })

  it('shows every rule the page uses when nothing is selected, and no element block', () => {
    const { pageId, cardId, h1Rule, pRule, resetRule } = setup()

    const doc = deriveCssPanelDocument(state(), canvas)!
    expect(doc.docKey).toBe(`css:page:${pageId}`)
    expect(doc.projection.blocks.map((b) => [b.origin, b.ruleId])).toEqual([
      ['class', cardId],
      ['ambient', h1Rule.id],
      ['ambient', pRule.id],
      ['ambient', resetRule.id],
      ['framework', 'gen-text-m'],
    ])
    expect(doc.projection.text).toContain('/* p · ambient rule · matches 1 element on this page */')
    expect(doc.projection.text).toContain('/* * · ambient rule · matches 3 elements on this page */')
    expect(doc.projection.text).not.toContain('nav a')
    expect(doc.projection.blocks.some((b) => b.origin === 'inline')).toBe(false)
  })

  it('still lists assigned classes for a selection whose element is not rendered yet', () => {
    const { paragraphId, cardId } = setup()
    document.body.innerHTML = ''
    state().selectNode(paragraphId)

    const doc = deriveCssPanelDocument(state(), canvas)!
    expect(doc.projection.blocks.map((b) => [b.origin, b.ruleId ?? b.nodeId])).toEqual([
      ['class', cardId],
      ['inline', paragraphId],
    ])
  })

  it('returns null without a site', () => {
    state().clearSite()
    expect(deriveCssPanelDocument(state(), canvas)).toBeNull()
  })
})
