/**
 * createPageScript — the God Mode JS panel's lazy asset creation: one undo
 * step that adds the script file AND its page-only runtime scope.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { collectRuntimeScripts, findPageScript } from '@core/site-runtime'

function state() {
  return useEditorStore.getState()
}

beforeEach(() => {
  state().clearSite()
  useEditorStore.setState({ activePageId: null, activeDocument: null } as Parameters<typeof useEditorStore.setState>[0])
})

describe('createPageScript', () => {
  it('creates scripts/pages/<slug>.js scoped to exactly that page, as one undo step', () => {
    const site = state().createSite('Scripts')
    const pageId = site.pages[0].id
    const before = state().canUndo

    const fileId = state().createPageScript(pageId, "console.log('hi')")

    const file = state().site!.files.find((f) => f.id === fileId)!
    expect(file).toMatchObject({ path: 'scripts/pages/index.js', type: 'script', content: "console.log('hi')" })
    expect(state().siteRuntime.scripts[fileId].scope).toEqual({ type: 'pages', pageIds: [pageId] })
    expect(state().site!.runtime.scripts[fileId].scope).toEqual({ type: 'pages', pageIds: [pageId] })
    expect(findPageScript(state().site!.files, state().siteRuntime, pageId)?.id).toBe(fileId)

    state().undo()
    expect(state().site!.files.some((f) => f.id === fileId)).toBe(false)
    expect(state().siteRuntime.scripts[fileId]).toBeUndefined()
    expect(state().site!.runtime.scripts[fileId]).toBeUndefined()
    expect(state().canUndo).toBe(before)
  })

  it('runs in canvas and publish for its page only, through the existing runtime pipeline', () => {
    const site = state().createSite('Scripts')
    const home = site.pages[0]
    const otherId = state().addPage('Other', 'other').id
    const fileId = state().createPageScript(home.id, 'document.title = "x"')
    const files = state().site!.files
    const runtime = state().siteRuntime
    const other = state().site!.pages.find((p) => p.id === otherId)!

    for (const target of ['canvas', 'publish'] as const) {
      expect(collectRuntimeScripts({ files, runtime, page: home, target }).map((s) => s.file.id)).toEqual([fileId])
      expect(collectRuntimeScripts({ files, runtime, page: other, target })).toEqual([])
    }
  })

  it('throws for an unknown page', () => {
    state().createSite('Scripts')
    expect(() => state().createPageScript('nope', '')).toThrow()
  })
})
