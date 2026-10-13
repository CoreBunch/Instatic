/**
 * insertFragment — a resolved fragment plan lands in the editor store as ONE
 * undo step, at the location the current selection resolves to.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { fragmentInsertDocument } from '@site/store/slices/fragmentsSlice'
import {
  extractFragment,
  fragmentSourceFromSite,
  planFragmentInsert,
  resolveFragmentPlan,
  type SiteFragment,
} from '@core/fragments'
import { SOURCE_ROWS, SOURCE_TABLES, makeSourceSite, sourceMediaWithBytes } from '../fragments/fixtures'
import '@modules/base/index'

function freshStore(): void {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

async function sectionFragment(): Promise<SiteFragment> {
  const source = fragmentSourceFromSite(makeSourceSite(), { tables: SOURCE_TABLES, rows: SOURCE_ROWS, media: sourceMediaWithBytes() })
  return (await extractFragment(source, { pageId: 'page-home', rootNodeIds: ['hero'] })).fragment
}

function resolvedPlanForStore(fragment: SiteFragment) {
  const state = useEditorStore.getState()
  const plan = planFragmentInsert(
    { site: state.site!, tables: [], document: fragmentInsertDocument(state) ?? undefined },
    fragment,
  )
  return resolveFragmentPlan(plan, {
    mediaUrlByPath: new Map(plan.media.map((m) => [m.path, `/uploads/copied-${m.filename}`])),
    tableIdMap: new Map(plan.tables.map((t) => [t.fragmentTableId, `server-${t.slug}`])),
    fontEntryByFamilyId: new Map(),
  })
}

describe('insertFragment', () => {
  it('inserts the section, its rules, tokens and components, and selects it', async () => {
    const site = useEditorStore.getState().createSite('Target')
    const rootId = site.pages[0].rootNodeId
    const resolved = resolvedPlanForStore(await sectionFragment())

    const result = useEditorStore.getState().insertFragment(resolved)
    expect(result?.rootIds).toHaveLength(1)
    const after = useEditorStore.getState()
    const page = after.site!.pages[0]
    expect(page.nodes[rootId].children).toContain(result!.rootIds[0])
    expect(after.selectedNodeId).toBe(result!.rootIds[0])
    expect(after.site!.visualComponents.map((vc) => vc.name).sort()).toEqual(['Badge', 'Card'])
    expect(after.site!.settings.framework!.colors.tokens.map((t) => t.slug).sort()).toEqual(['accent', 'primary'])
    // The colour utilities were regenerated in the same transaction.
    expect(Object.values(after.site!.styleRules).some((r) => r.name === 'text-primary')).toBe(true)
    const image = Object.values(page.nodes).find((n) => n.moduleId === 'base.image')!
    expect(image.props.src).toBe('/uploads/copied-photo.jpg')
  })

  it("never duplicates the seeded font role tokens of a new site", async () => {
    useEditorStore.getState().createSite('Target')
    const before = useEditorStore.getState().site!.settings.fonts?.tokens?.map((t) => t.variable) ?? []
    expect(before).toContain('font-heading')
    useEditorStore.getState().insertFragment(resolvedPlanForStore(await sectionFragment()))
    const after = useEditorStore.getState().site!.settings.fonts?.tokens?.map((t) => t.variable) ?? []
    expect(after).toEqual(before)
  })

  it('one undo removes the whole insert', async () => {
    const site = useEditorStore.getState().createSite('Target')
    const before = useEditorStore.getState().site!
    const resolved = resolvedPlanForStore(await sectionFragment())
    useEditorStore.getState().insertFragment(resolved)

    useEditorStore.getState().undo()
    const undone = useEditorStore.getState().site!
    expect(undone.pages[0].nodes).toEqual(before.pages[0].nodes)
    expect(Object.keys(undone.styleRules).sort()).toEqual(Object.keys(before.styleRules).sort())
    expect(undone.visualComponents).toEqual([])
    expect(undone.settings.framework).toEqual(before.settings.framework)
    expect(undone.pages[0].nodes[site.pages[0].rootNodeId].children).toEqual([])
  })

  it('refuses a plan made for another document', async () => {
    useEditorStore.getState().createSite('Target')
    const resolved = resolvedPlanForStore(await sectionFragment())
    expect(useEditorStore.getState().insertFragment({ ...resolved, document: { kind: 'page', pageId: 'elsewhere' } })).toBeNull()
  })

  it('a page fragment adds a page', async () => {
    useEditorStore.getState().createSite('Target')
    const source = fragmentSourceFromSite(makeSourceSite(), { tables: SOURCE_TABLES, rows: SOURCE_ROWS, media: sourceMediaWithBytes() })
    const { fragment } = await extractFragment(source, { pageId: 'page-about' })
    const result = useEditorStore.getState().insertFragment(resolvedPlanForStore(fragment))
    const page = useEditorStore.getState().site!.pages.find((p) => p.id === result?.pageId)
    expect(page?.slug).toBe('about')
  })
})
