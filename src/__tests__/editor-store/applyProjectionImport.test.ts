/**
 * applyProjectionImport — the God Mode HTML panel's write: splice a
 * uid-preserving import result into the active tree as ONE undo step,
 * keeping untouched nodes' identity and pruning deleted nodes from the
 * selection.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { registry } from '@core/module-engine'
import { renderNode, type RenderConfig } from '@core/publisher'
import { importProjectionHtml } from '@core/htmlImport'
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

function importEdited(rootId: string, html: string) {
  const site = state().site!
  return importProjectionHtml(html, { tree: site.pages[0], rootId, styleRules: site.styleRules })
}

function setup() {
  state().clearSite()
  useEditorStore.setState({ activePageId: null, activeDocument: null, selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
  const site = state().createSite('HTML panel')
  const rootId = site.pages[0].rootNodeId
  const containerId = state().insertNode('base.container', {}, rootId)
  const textId = state().insertNode('base.text', { text: 'Hello', tag: 'p' }, containerId)
  const siblingId = state().insertNode('base.text', { text: 'Bye', tag: 'p' }, containerId)
  state().renameNode(siblingId, 'Farewell')
  return { rootId, containerId, textId, siblingId }
}

beforeEach(setup)

describe('applyProjectionImport', () => {
  it('patches matched nodes in place, keeps sibling identity and metadata, and undoes as one step', () => {
    const { rootId, containerId, textId, siblingId } = setup()
    const html = projection(containerId).replace('Hello', 'Hello, world')
    const result = importEdited(containerId, html)
    expect(result.diff.patchedIds).toContain(textId)

    const applied = state().applyProjectionImport(result)
    expect(applied).toBe(true)
    const page = state().site!.pages[0]
    expect(page.nodes[textId].props.text).toBe('Hello, world')
    expect(page.nodes[siblingId]).toMatchObject({ label: 'Farewell', parentId: containerId })
    expect(page.nodes[containerId].children).toEqual([textId, siblingId])
    expect(page.nodes[rootId].children).toEqual([containerId])

    state().undo()
    expect(state().site!.pages[0].nodes[textId].props.text).toBe('Hello')
  })

  it('creates nodes for new tags, deletes vanished ones, and prunes them from the selection', () => {
    const { containerId, textId, siblingId } = setup()
    state().selectNode(siblingId)
    const html = projection(containerId)
      .replace(/<p uid="[^"]*">Bye<\/p>/, '')
      .replace('</div>', '<h2 class="brand-new">New</h2></div>')
    const result = importEdited(containerId, html)
    expect(result.diff.deletedIds).toEqual([siblingId])
    expect(result.diff.createdIds).toHaveLength(1)

    state().applyProjectionImport(result)
    const page = state().site!.pages[0]
    expect(page.nodes[siblingId]).toBeUndefined()
    const [createdId] = result.diff.createdIds
    expect(page.nodes[createdId]).toMatchObject({ parentId: containerId })
    expect(page.nodes[containerId].children).toEqual([textId, createdId])
    // A class name typed in HTML links to a real registry class.
    const classId = page.nodes[createdId].classIds[0]
    expect(state().site!.styleRules[classId]?.name).toBe('brand-new')
    expect(state().selectedNodeId).toBeNull()
  })

  it('keeps an existing class assignment intact when the node is edited', () => {
    const { containerId, textId } = setup()
    const card = state().createClass('card', { color: 'red' })
    state().addNodeClass(textId, card.id)
    const rulesBefore = Object.keys(state().site!.styleRules).length

    const html = projection(containerId).replace('Hello', 'Hello again')
    state().applyProjectionImport(importEdited(containerId, html))

    const page = state().site!.pages[0]
    expect(page.nodes[textId].props.text).toBe('Hello again')
    expect(page.nodes[textId].classIds).toEqual([card.id])
    expect(Object.keys(state().site!.styleRules)).toHaveLength(rulesBefore)
  })

  it('applies a whole-page projection against the page root', () => {
    const { rootId, containerId } = setup()
    const html = `${projection(rootId)}<p>Appended</p>`
    const result = importEdited(rootId, html)
    state().applyProjectionImport(result)
    const page = state().site!.pages[0]
    expect(page.nodes[rootId].children).toHaveLength(2)
    expect(page.nodes[rootId].children[0]).toBe(containerId)
    expect(page.nodes[page.nodes[rootId].children[1]].props.text).toBe('Appended')
  })

  it('refuses a result whose root is not in the active tree', () => {
    const { containerId } = setup()
    const result = importEdited(containerId, projection(containerId))
    state().deleteNode(containerId)
    expect(state().applyProjectionImport(result)).toBe(false)
  })
})
