/**
 * applyProjectionImport write scope — a live apply writes what the import's
 * diff changed and nothing else. Every node the recipe reassigns becomes a
 * whole-node rewrite in the collab doc, pinned by the undo manager for as
 * long as the step is undoable; rewriting the whole projected subtree per
 * debounced keystroke retained the entire tree per apply on a large page
 * until the renderer ran out of memory.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import { useEditorStore } from '@site/store/store'
import { collabDocFor } from '@site/store/slices/site/collabBinding'
import { encodeCollabDocId, treeMap } from '@core/collab'
import { registry } from '@core/module-engine'
import { renderNode, type RenderConfig } from '@core/publisher'
import { importProjectionHtml } from '@core/htmlImport'
import { makeAccumulators } from '../publisher/helpers'
import '@modules/base/index'

const SECTIONS = 30
const PER_SECTION = 5

function state() {
  return useEditorStore.getState()
}

function page() {
  return state().site!.pages[0]
}

function projection(rootId: string): string {
  const site = state().site!
  const config: RenderConfig = { page: page(), site, registry, breakpointId: undefined, projection: true }
  return renderNode(rootId, config, makeAccumulators())
}

function importEdited(rootId: string, html: string) {
  return importProjectionHtml(html, { tree: page(), rootId, styleRules: state().site!.styleRules })
}

function pageDoc(): Y.Doc {
  return collabDocFor(encodeCollabDocId({ kind: 'page', rowId: page().id }))!
}

function structCount(doc: Y.Doc): number {
  let n = 0
  for (const structs of doc.store.clients.values()) n += structs.length
  return n
}

function nodeMapIdentities(doc: Y.Doc): Map<string, unknown> {
  const yNodes = treeMap(doc).get('nodes') as Y.Map<unknown>
  return new Map([...yNodes.entries()])
}

/** Node ids present in both reads whose Y.Map instance was replaced (deleted ids are asserted separately). */
function rewrittenNodeIds(before: Map<string, unknown>, after: Map<string, unknown>): string[] {
  return [...before].filter(([id, map]) => after.has(id) && after.get(id) !== map).map(([id]) => id)
}

let rootId = ''
/** textIds[section][index] */
let textIds: string[][] = []
let sectionIds: string[] = []

beforeEach(() => {
  state().clearSite()
  useEditorStore.setState({ activePageId: null, activeDocument: null, selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
  const site = state().createSite('Write scope')
  rootId = site.pages[0].rootNodeId
  textIds = []
  sectionIds = []
  for (let s = 0; s < SECTIONS; s++) {
    const sectionId = state().insertNode('base.container', {}, rootId)
    sectionIds.push(sectionId)
    textIds.push([])
    for (let t = 0; t < PER_SECTION; t++) {
      textIds[s].push(state().insertNode('base.text', { text: `Paragraph ${s}-${t}`, tag: 'p' }, sectionId))
    }
  }
})

describe('applyProjectionImport write scope', () => {
  it('a one-node text edit rewrites only that node in the collab doc and keeps every other node object', () => {
    const doc = pageDoc()
    const structsBefore = structCount(doc)
    const identitiesBefore = nodeMapIdentities(doc)
    const nodesBefore = page().nodes
    const edited = textIds[0][0]

    const result = importEdited(rootId, projection(rootId).replace('Paragraph 0-0', 'Paragraph 0-0x'))
    expect(result.diff).toMatchObject({ patchedIds: [edited], createdIds: [], deletedIds: [] })
    expect(state().applyProjectionImport(result)).toBe(true)

    const nodes = page().nodes
    expect(nodes[edited].props.text).toBe('Paragraph 0-0x')
    expect(nodes[edited].parentId).toBe(sectionIds[0])
    for (const id of Object.keys(nodesBefore)) {
      if (id !== edited) expect(nodes[id]).toBe(nodesBefore[id])
    }
    expect(rewrittenNodeIds(identitiesBefore, nodeMapIdentities(doc))).toEqual([edited])
    // One node map plus its props/children containers — not the tree.
    expect(structCount(doc) - structsBefore).toBeLessThan(40)

    state().undo()
    expect(page().nodes[edited].props.text).toBe('Paragraph 0-0')
  })

  it('a move, a delete and a create write only the nodes involved and re-link their parents', () => {
    const doc = pageDoc()
    const identitiesBefore = nodeMapIdentities(doc)
    const nodesBefore = page().nodes
    const moved = textIds[0][0]
    const removed = textIds[0][1]
    const html = projection(rootId)
    const movedTag = new RegExp(`<p uid="${moved}"[^>]*>Paragraph 0-0</p>`).exec(html)![0]
    const removedTag = new RegExp(`<p uid="${removed}"[^>]*>Paragraph 0-1</p>`).exec(html)![0]
    const anchorTag = new RegExp(`<p uid="${textIds[1][0]}"[^>]*>Paragraph 1-0</p>`).exec(html)![0]
    const edited = html
      .replace(movedTag, '')
      .replace(removedTag, '')
      .replace(anchorTag, `${anchorTag}${movedTag}<h2 class="brand-new">New</h2>`)

    const result = importEdited(rootId, edited)
    expect(result.diff.deletedIds).toEqual([removed])
    expect(result.diff.createdIds).toHaveLength(1)
    expect(result.diff.patchedIds.sort()).toEqual([sectionIds[0], sectionIds[1]].sort())
    expect(state().applyProjectionImport(result)).toBe(true)

    const [created] = result.diff.createdIds
    const nodes = page().nodes
    expect(nodes[removed]).toBeUndefined()
    expect(nodes[sectionIds[0]].children).toEqual(textIds[0].slice(2))
    expect(nodes[sectionIds[1]].children).toEqual([textIds[1][0], moved, created, ...textIds[1].slice(1)])
    expect(nodes[moved].parentId).toBe(sectionIds[1])
    expect(nodes[created].parentId).toBe(sectionIds[1])
    // The moved node changes only its (derived) parent; its untouched
    // siblings and every other section keep their objects.
    expect(nodes[moved]).toEqual({ ...nodesBefore[moved], parentId: sectionIds[1] })
    for (const id of [...textIds[0].slice(2), ...textIds[1]]) expect(nodes[id]).toBe(nodesBefore[id])
    for (const s of [2, 3, 4]) expect(nodes[sectionIds[s]]).toBe(nodesBefore[sectionIds[s]])

    const identitiesAfter = nodeMapIdentities(doc)
    expect(identitiesAfter.has(removed)).toBe(false)
    expect(identitiesAfter.has(created)).toBe(true)
    expect(rewrittenNodeIds(identitiesBefore, identitiesAfter).sort()).toEqual([sectionIds[0], sectionIds[1]].sort())

    state().undo()
    expect(page().nodes[removed]).toBeDefined()
    expect(page().nodes[created]).toBeUndefined()
    expect(page().nodes[moved].parentId).toBe(sectionIds[0])
  })
})
