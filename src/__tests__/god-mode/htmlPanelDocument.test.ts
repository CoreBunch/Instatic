/**
 * deriveHtmlPanelDocument — what the God Mode HTML panel projects for the
 * current selection: the selected subtree, the whole page, a Component
 * definition in VC canvas mode, or a read-only view of a Component
 * instance's internals with a jump to the definition.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { deriveHtmlPanelDocument } from '@site/code-dock/html/htmlPanelDocument'
import '@modules/base/index'

function state() {
  return useEditorStore.getState()
}

function inputs() {
  const s = state()
  return { site: s.site, activeDocument: s.activeDocument, activePageId: s.activePageId, selectedNodeId: s.selectedNodeId }
}

function setup() {
  state().clearSite()
  useEditorStore.setState({ activePageId: null, activeDocument: null, selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
  const site = state().createSite('HTML panel')
  const page = site.pages[0]
  const containerId = state().insertNode('base.container', {}, page.rootNodeId)
  const textId = state().insertNode('base.text', { text: 'Hello {page.title}', tag: 'p' }, containerId)
  return { pageId: page.id, rootId: page.rootNodeId, containerId, textId }
}

beforeEach(setup)

describe('deriveHtmlPanelDocument', () => {
  it('projects the selected subtree with uids and verbatim tokens', () => {
    const { containerId, textId } = setup()
    state().selectNode(containerId)
    const doc = deriveHtmlPanelDocument(inputs())!
    expect(doc).toMatchObject({ docKey: `html:node:${containerId}`, rootId: containerId, readOnly: false })
    expect(doc.html).toContain(`uid="${containerId}"`)
    expect(doc.html).toContain(`<p uid="${textId}">Hello {page.title}</p>`)
    expect(doc.tree.nodes[containerId]).toBeDefined()
  })

  it('projects the whole page when nothing is selected', () => {
    const { pageId, rootId, containerId } = setup()
    const doc = deriveHtmlPanelDocument(inputs())!
    expect(doc).toMatchObject({ docKey: `html:page:${pageId}`, rootId, readOnly: false })
    expect(doc.html).toStartWith(`<div uid="${containerId}"`)
  })

  it('projects a Component definition, fully editable, in VC canvas mode', () => {
    setup()
    const vcId = state().createVisualComponent('Card')
    const vc = state().site!.visualComponents.find((v) => v.id === vcId)!
    useEditorStore.setState({ activeDocument: { kind: 'visualComponent', vcId }, selectedNodeId: null } as Parameters<typeof useEditorStore.setState>[0])
    const doc = deriveHtmlPanelDocument(inputs())!
    expect(doc).toMatchObject({ docKey: `html:vc:${vcId}`, rootId: vc.tree.rootNodeId, readOnly: false })
    expect(doc.tree).toBe(state().site!.visualComponents.find((v) => v.id === vcId)!.tree)
  })

  it("shows a Component instance's internals read-only with a jump to the definition", () => {
    const { containerId } = setup()
    const vcId = state().createVisualComponent('Card')
    useEditorStore.setState({ activeDocument: { kind: 'visualComponent', vcId } } as Parameters<typeof useEditorStore.setState>[0])
    const vcRootId = state().site!.visualComponents.find((v) => v.id === vcId)!.tree.rootNodeId
    const internalId = state().insertNode('base.text', { text: 'Inside', tag: 'p' }, vcRootId)
    useEditorStore.setState({ activeDocument: null } as Parameters<typeof useEditorStore.setState>[0])
    state().insertComponentRef(containerId, vcId)

    state().selectNode(internalId)
    const doc = deriveHtmlPanelDocument(inputs())!
    expect(doc).toMatchObject({ docKey: `html:internal:${internalId}`, rootId: internalId, readOnly: true, definitionVcId: vcId })
    expect(doc.html).toContain('Inside')
  })

  it('returns null without a site', () => {
    state().clearSite()
    expect(deriveHtmlPanelDocument(inputs())).toBeNull()
  })
})
