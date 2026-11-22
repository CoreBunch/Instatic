import { afterEach, expect, it } from 'bun:test'
import '@modules/base'
import { encodeCollabDocId, projectPageDoc } from '@core/collab'
import { createDetachedCollabDocSet } from '@site/store/slices/site/detachedCollabDocs'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite } from '../fixtures'

function pageId(id: string) {
  return encodeCollabDocId({ kind: 'page', branchId: 'main', rowId: id })
}

afterEach(() => useEditorStore.getState().clearSite())

it('allocates only the requested row and seeds it once', () => {
  const pages = Array.from({ length: 100 }, (_, i) => makePage({ id: `page-${i}` }))
  const created: string[] = []
  const docs = createDetachedCollabDocSet(makeSite({ pages }), 'main', (id) => { created.push(id) })
  expect([...docs.entries()]).toHaveLength(0)
  const doc = docs.get(pageId('page-42'))!
  expect(projectPageDoc(doc, 'page-42')).toEqual(pages[42])
  expect(docs.ensure(pageId('page-42'))).toBe(doc)
  expect(created).toEqual([pageId('page-42')])
  expect([...docs.entries()]).toHaveLength(1)
  expect(docs.get(pageId('missing'))).toBeUndefined()
  docs.delete(pageId('page-43'))
  expect(docs.get(pageId('page-43'))).toBeUndefined()
  docs.delete(pageId('page-42'))
})

it('keeps initial content available when the first edit is undone and redone', () => {
  const page = makePage()
  useEditorStore.getState().loadSite(makeSite({ pages: [page] }))
  useEditorStore.getState().renameNode(page.rootNodeId, 'Renamed root')
  expect(useEditorStore.getState().site!.pages[0].nodes.root.label).toBe('Renamed root')
  useEditorStore.getState().undo()
  expect(useEditorStore.getState().site!.pages[0].nodes.root.label).toBeUndefined()
  expect(useEditorStore.getState().site!.pages[0].title).toBe(page.title)
  useEditorStore.getState().redo()
  expect(useEditorStore.getState().site!.pages[0].nodes.root.label).toBe('Renamed root')
})

it('restores an untouched deleted page through roster undo', () => {
  const first = makePage()
  const second = makePage({ id: 'untouched', title: 'Untouched', slug: 'untouched' })
  useEditorStore.getState().loadSite(makeSite({ pages: [first, second] }))
  useEditorStore.getState().deletePage(second.id)
  expect(useEditorStore.getState().site!.pages.map((p) => p.id)).toEqual([first.id])
  useEditorStore.getState().undo()
  expect(useEditorStore.getState().site!.pages).toEqual([first, second])
  useEditorStore.getState().redo()
  expect(useEditorStore.getState().site!.pages.map((p) => p.id)).toEqual([first.id])
})
