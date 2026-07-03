/**
 * Visual Component mutation contract.
 *
 * Visual Components live inside the assembled SiteDocument, so every action
 * that mutates them must use the same document mutation contract as page/tree
 * actions: capture an undo step (via the collab binding's per-doc
 * Y.UndoManagers) and allow undo to restore the previous SiteDocument.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { collabClearHistory } from '@site/store/slices/site/collabBinding'
import { makeNode, makePage, makeSite, makeVC, makeVCNode } from '../fixtures'

function freshStore() {
  useEditorStore.getState().clearSite()
  useEditorStore.setState({
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
  })
}

function loadSiteWithCardVc() {
  const vc = makeVC({
    id: 'vc-card',
    name: 'Card',
    params: [
      {
        id: 'param-title',
        name: 'title',
        type: 'string',
        defaultValue: 'Default title',
        required: false,
      },
    ],
  })
  const site = makeSite({ visualComponents: [vc] })
  useEditorStore.getState().loadSite(site)
}

function expectMutationContract(action: () => void, assertChanged: () => void): void {
  expect(useEditorStore.getState().canUndo).toBe(false)

  action()
  assertChanged()

  expect(useEditorStore.getState().canUndo).toBe(true)

  useEditorStore.getState().undo()

  expect(useEditorStore.getState().canRedo).toBe(true)
}

describe('Visual Component actions use the SiteDocument mutation contract', () => {
  beforeEach(freshStore)

  it('createVisualComponent is dirty and undoable', () => {
    useEditorStore.getState().loadSite(makeSite())

    expectMutationContract(
      () => {
        useEditorStore.getState().createVisualComponent('Hero')
      },
      () => {
        expect(useEditorStore.getState().site!.visualComponents.map((vc) => vc.name)).toContain('Hero')
      },
    )

    expect(useEditorStore.getState().site!.visualComponents.map((vc) => vc.name)).not.toContain('Hero')
  })

  it('renameVisualComponent is dirty and undoable', () => {
    loadSiteWithCardVc()

    expectMutationContract(
      () => {
        useEditorStore.getState().renameVisualComponent('vc-card', 'Feature Card')
      },
      () => {
        expect(useEditorStore.getState().site!.visualComponents[0].name).toBe('Feature Card')
      },
    )

    expect(useEditorStore.getState().site!.visualComponents[0].name).toBe('Card')
  })

  it('addParam is dirty and undoable', () => {
    loadSiteWithCardVc()

    expectMutationContract(
      () => {
        useEditorStore.getState().addParam('vc-card', 'subtitle', 'string', '')
      },
      () => {
        expect(useEditorStore.getState().site!.visualComponents[0].params.map((p) => p.name)).toContain('subtitle')
      },
    )

    expect(useEditorStore.getState().site!.visualComponents[0].params.map((p) => p.name)).not.toContain('subtitle')
  })

  it('addNodeToVc is dirty and undoable', () => {
    loadSiteWithCardVc()

    expectMutationContract(
      () => {
        useEditorStore.getState().addNodeToVc(
          'vc-card',
          'vc-root',
          makeVCNode({ id: 'vc-text', moduleId: 'base.text' }),
        )
      },
      () => {
        expect(useEditorStore.getState().site!.visualComponents[0].tree.nodes['vc-text']).toBeDefined()
      },
    )

    expect(useEditorStore.getState().site!.visualComponents[0].tree.nodes['vc-text']).toBeUndefined()
  })

  it('setNodePropBinding and clearNodePropBinding are dirty and undoable in VC mode', () => {
    loadSiteWithCardVc()
    useEditorStore.setState({ activeDocument: { kind: 'visualComponent', vcId: 'vc-card' } })

    expectMutationContract(
      () => {
        useEditorStore.getState().setNodePropBinding('vc-root', 'text', 'param-title')
      },
      () => {
        expect(
          useEditorStore.getState().site!.visualComponents[0].tree.nodes['vc-root'].propBindings?.text?.paramId,
        ).toBe('param-title')
      },
    )

    expect(useEditorStore.getState().site!.visualComponents[0].tree.nodes['vc-root'].propBindings).toBeUndefined()

    useEditorStore.getState().setNodePropBinding('vc-root', 'text', 'param-title')
    collabClearHistory()

    expectMutationContract(
      () => {
        useEditorStore.getState().clearNodePropBinding('vc-root', 'text')
      },
      () => {
        expect(useEditorStore.getState().site!.visualComponents[0].tree.nodes['vc-root'].propBindings).toEqual({})
      },
    )

    expect(
      useEditorStore.getState().site!.visualComponents[0].tree.nodes['vc-root'].propBindings?.text?.paramId,
    ).toBe('param-title')
  })

  it('convertNodeToComponent is dirty and undoable', () => {
    const page = makePage({
      id: 'page-1',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['text-1'] }),
        'text-1': makeNode({ id: 'text-1', moduleId: 'base.text', props: { text: 'Hello' } }),
      },
    })
    useEditorStore.getState().loadSite(makeSite({ pages: [page] }))

    expectMutationContract(
      () => {
        useEditorStore.getState().convertNodeToComponent('text-1', 'Text Card')
      },
      () => {
        expect(useEditorStore.getState().site!.visualComponents.map((vc) => vc.name)).toContain('Text Card')
        expect(useEditorStore.getState().site!.pages[0].nodes['text-1']).toBeUndefined()
      },
    )

    expect(useEditorStore.getState().site!.visualComponents.map((vc) => vc.name)).not.toContain('Text Card')
    expect(useEditorStore.getState().site!.pages[0].nodes['text-1']).toBeDefined()
  })
})
