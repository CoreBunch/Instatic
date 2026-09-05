/**
 * applyStylesheetEdit — the God Mode CSS panel's atomic write into the
 * style-rule registry + the selected node's inline styles. One call = one
 * undo step, however many rules it touches.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import type { StyleRule } from '@core/page-tree'
import type { StylesheetEdit } from '@core/cssProjection'
import '@modules/base/index'

function freshStore() {
  useEditorStore.getState().clearSite()
  useEditorStore.setState({
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeDocument: null,
    activeClassId: null,
    selectedSelectorClassId: null,
    selectedSelectorClassIds: [],
    previewClassAssignment: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

function state() {
  return useEditorStore.getState()
}

function rulesBySelector(): Record<string, StyleRule> {
  return Object.fromEntries(Object.values(state().site!.styleRules).map((r) => [r.selector, r]))
}

function setup() {
  const site = state().createSite('Stylesheet edit')
  const rootId = site.pages[0].rootNodeId
  const nodeId = state().insertNode('base.container', {}, rootId)
  const card = state().createClass('card', { color: 'red' })
  state().addNodeClass(nodeId, card.id)
  const heading = state().createAmbientRule({ selector: 'h1', styles: { fontWeight: '700' } })
  state().setNodeInlineStyles(nodeId, { marginTop: '4px' })
  return { nodeId, cardId: card.id, headingId: heading.id }
}

function emptyEdit(): StylesheetEdit {
  return { rules: [], conditions: [], clearedClassIds: [], deletedAmbientIds: [], inlineStyles: null }
}

describe('applyStylesheetEdit', () => {
  it('applies rule upserts, ambient deletions and inline styles as ONE undo step', () => {
    const { nodeId, headingId } = setup()
    const result = state().applyStylesheetEdit({
      ...emptyEdit(),
      rules: [
        { kind: 'class', name: 'card', selector: '.card', order: 0, styles: { color: 'blue' }, contextStyles: { tablet: { color: 'green' } } },
        { kind: 'class', name: 'brand-new', selector: '.brand-new', order: 1, styles: { color: 'hotpink' }, contextStyles: {} },
      ],
      deletedAmbientIds: [headingId],
      inlineStyles: { nodeId, styles: { marginTop: '8px' } },
    })

    expect(result).toMatchObject({ created: 1, updated: 1, deleted: 1, inlineChanged: true, blockedSelectors: [] })
    const rules = rulesBySelector()
    expect(rules['.card'].styles).toEqual({ color: 'blue' })
    expect(rules['.card'].contextStyles).toEqual({ tablet: { color: 'green' } })
    expect(rules['.brand-new'].kind).toBe('class')
    expect(rules['h1']).toBeUndefined()
    const node = state().site!.pages[0].nodes[nodeId]
    expect(node.inlineStyles).toEqual({ marginTop: '8px' })
    // The new class is a registry rule only — assignment stays explicit.
    expect(node.classIds).not.toContain(rules['.brand-new'].id)

    state().undo()
    const restored = rulesBySelector()
    expect(restored['.card'].styles).toEqual({ color: 'red' })
    expect(restored['.brand-new']).toBeUndefined()
    expect(restored['h1'].id).toBe(headingId)
    expect(state().site!.pages[0].nodes[nodeId].inlineStyles).toEqual({ marginTop: '4px' })
  })

  it('clears a removed class block but keeps the class and its assignments', () => {
    const { nodeId, cardId } = setup()
    state().applyStylesheetEdit({ ...emptyEdit(), clearedClassIds: [cardId] })
    const card = state().site!.styleRules[cardId]
    expect(card).toBeDefined()
    expect(card.styles).toEqual({})
    expect(state().site!.pages[0].nodes[nodeId].classIds).toContain(cardId)
  })

  it('refuses edits to locked framework rules and reports them', () => {
    setup()
    useEditorStore.setState((s) => {
      s.site!.styleRules['gen-1'] = {
        id: 'gen-1',
        name: 'text-m',
        kind: 'class',
        selector: '.text-m',
        order: 99,
        styles: { fontSize: 'var(--text-m)' },
        contextStyles: {},
        generated: { origin: 'framework', family: 'typography', sourceId: 'body', generatorId: 'g', tokenName: 'text', step: 'm', locked: true },
        createdAt: 1,
        updatedAt: 1,
      }
    })
    const result = state().applyStylesheetEdit({
      ...emptyEdit(),
      rules: [{ kind: 'class', name: 'text-m', selector: '.text-m', order: 0, styles: { fontSize: '99px' }, contextStyles: {} }],
    })
    expect(result.blockedSelectors).toEqual(['.text-m'])
    expect(state().site!.styleRules['gen-1'].styles).toEqual({ fontSize: 'var(--text-m)' })
  })

  it('records nothing for an edit that changes nothing', () => {
    const { nodeId } = setup()
    const before = state().site
    const result = state().applyStylesheetEdit({
      ...emptyEdit(),
      rules: [{ kind: 'class', name: 'card', selector: '.card', order: 0, styles: { color: 'red' }, contextStyles: {} }],
      inlineStyles: { nodeId, styles: { marginTop: '4px' } },
    })
    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0, cleared: 0, inlineChanged: false })
    expect(state().site).toBe(before)
  })

  it('makes consecutive applies separate undo steps', () => {
    const { nodeId } = setup()
    state().applyStylesheetEdit({ ...emptyEdit(), inlineStyles: { nodeId, styles: { marginTop: '8px' } } })
    state().applyStylesheetEdit({ ...emptyEdit(), inlineStyles: { nodeId, styles: { marginTop: '12px' } } })
    state().undo()
    expect(state().site!.pages[0].nodes[nodeId].inlineStyles).toEqual({ marginTop: '8px' })
  })

  it('writes inline styles into the active Visual Component tree when one is open', () => {
    setup()
    const vcId = state().createVisualComponent('Card')
    const vc = state().site!.visualComponents.find((v) => v.id === vcId)!
    const vcRootId = vc.tree.rootNodeId
    useEditorStore.setState({ activeDocument: { kind: 'visualComponent', vcId } } as Parameters<typeof useEditorStore.setState>[0])
    const result = state().applyStylesheetEdit({
      ...emptyEdit(),
      inlineStyles: { nodeId: vcRootId, styles: { padding: '1rem' } },
    })
    expect(result.inlineChanged).toBe(true)
    const tree = state().site!.visualComponents.find((v) => v.id === vc.id)!.tree
    expect(tree.nodes[vcRootId].inlineStyles).toEqual({ padding: '1rem' })
  })
})
