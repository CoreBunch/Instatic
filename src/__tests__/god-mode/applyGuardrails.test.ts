/**
 * summarizeDestructiveApply — what the HTML panel's destructive-diff confirm
 * lists: locked nodes and Component/slot structures an apply would remove
 * (or dismantle by re-tagging), named as the layer panel names them, with
 * descendants of a listed removal folded into it.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { registry } from '@core/module-engine'
import { renderNode, type RenderConfig } from '@core/publisher'
import { importProjectionHtml } from '@core/htmlImport'
import { summarizeDestructiveApply } from '@site/code-dock/html/applyGuardrails'
import { makeAccumulators } from '../publisher/helpers'
import '@modules/base/index'

function state() {
  return useEditorStore.getState()
}

function projection(rootId: string): string {
  const site = state().site!
  const page = site.pages[0]
  const config: RenderConfig = { page, site, registry, breakpointId: undefined, projection: true }
  return renderNode(rootId, config, makeAccumulators())
}

function summarize(rootId: string, html: string) {
  const site = state().site!
  const result = importProjectionHtml(html, { tree: site.pages[0], rootId, styleRules: site.styleRules })
  return summarizeDestructiveApply(result.diff, site.pages[0], site.visualComponents)
}

function setup() {
  state().clearSite()
  useEditorStore.setState({ activePageId: null, activeDocument: null, selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
  const site = state().createSite('Guardrails')
  const containerId = state().insertNode('base.container', {}, site.pages[0].rootNodeId)
  const textId = state().insertNode('base.text', { text: 'Hello', tag: 'p' }, containerId)
  return { containerId, textId }
}

function removeElement(html: string, uid: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const target = doc.body.querySelector(`[uid="${uid}"]`)
  expect(target).toBeTruthy()
  target!.remove()
  return doc.body.innerHTML
}

beforeEach(setup)

describe('summarizeDestructiveApply', () => {
  it('is empty for a plain content edit or an unlocked deletion', () => {
    const { containerId, textId } = setup()
    const html = projection(containerId)
    expect(summarize(containerId, html.replace('Hello', 'Hi'))).toEqual([])
    expect(summarize(containerId, removeElement(html, textId))).toEqual([])
  })

  it('lists a deleted locked node under its layer-panel name', () => {
    const { containerId, textId } = setup()
    state().renameNode(textId, 'Legal text')
    state().toggleNodeLocked(textId)
    const html = projection(containerId)
    expect(summarize(containerId, removeElement(html, textId))).toEqual([
      { id: textId, name: 'Legal text', reasons: ['locked'], retyped: false },
    ])
  })

  it('folds a removed Component instance and its slots into one entry', () => {
    const { containerId } = setup()
    const vcId = state().createVisualComponent('Card')
    useEditorStore.setState({ activeDocument: { kind: 'visualComponent', vcId } } as Parameters<typeof useEditorStore.setState>[0])
    const vcRootId = state().site!.visualComponents.find((v) => v.id === vcId)!.tree.rootNodeId
    state().insertNode('base.slot-outlet', { slotName: 'body' }, vcRootId)
    useEditorStore.setState({ activeDocument: null } as Parameters<typeof useEditorStore.setState>[0])
    const refId = state().insertComponentRef(containerId, vcId)!
    const slotId = state().site!.pages[0].nodes[refId].children[0]
    state().insertNode('base.text', { text: 'Filled', tag: 'p' }, slotId)

    const html = projection(containerId)
    expect(summarize(containerId, removeElement(html, refId))).toEqual([
      { id: refId, name: 'Card', reasons: ['component'], retyped: false },
    ])
  })

  it('lists a removed slot instance as a locked slot', () => {
    const { containerId } = setup()
    const vcId = state().createVisualComponent('Card')
    useEditorStore.setState({ activeDocument: { kind: 'visualComponent', vcId } } as Parameters<typeof useEditorStore.setState>[0])
    const vcRootId = state().site!.visualComponents.find((v) => v.id === vcId)!.tree.rootNodeId
    state().insertNode('base.slot-outlet', { slotName: 'body' }, vcRootId)
    useEditorStore.setState({ activeDocument: null } as Parameters<typeof useEditorStore.setState>[0])
    const refId = state().insertComponentRef(containerId, vcId)!
    const slotId = state().site!.pages[0].nodes[refId].children[0]

    const html = projection(containerId)
    expect(summarize(containerId, removeElement(html, slotId))).toEqual([
      { id: slotId, name: 'Slot: body', reasons: ['locked', 'slot'], retyped: false },
    ])
  })

  it('reports a re-tagged Component marker as dismantled, not deleted', () => {
    const { containerId } = setup()
    const vcId = state().createVisualComponent('Card')
    const refId = state().insertComponentRef(containerId, vcId)!
    const html = projection(containerId)
    const retagged = html
      .replace(`<instatic-component uid="${refId}"`, `<div uid="${refId}"`)
      .replace('</instatic-component>', '</div>')
    expect(summarize(containerId, retagged)).toEqual([
      { id: refId, name: 'Card', reasons: ['component'], retyped: true },
    ])
  })
})
