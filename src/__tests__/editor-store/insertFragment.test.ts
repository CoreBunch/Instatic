/**
 * insertFragment — a resolved fragment plan lands in the editor store as ONE
 * undo step, at the location the current selection resolves to.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { fragmentInsertDocument } from '@site/store/slices/fragmentsSlice'
import { planFragmentInsert, resolveFragmentPlan, type SiteFragment } from '@core/fragments'
import { extractFromSource } from '../fragments/fixtures'
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

const { fragment: section } = await extractFromSource()

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
  it('inserts the section, its rules, tokens and components, and selects it', () => {
    const site = useEditorStore.getState().createSite('Target')
    const rootId = site.pages[0].rootNodeId
    const resolved = resolvedPlanForStore(section)

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

  it('a second insert lands after the still-selected first section, not inside it', () => {
    const site = useEditorStore.getState().createSite('Target')
    const rootId = site.pages[0].rootNodeId

    const first = useEditorStore.getState().insertFragment(resolvedPlanForStore(section))
    expect(useEditorStore.getState().selectedNodeId).toBe(first!.rootIds[0])
    const second = useEditorStore.getState().insertFragment(resolvedPlanForStore(section))

    const nodes = useEditorStore.getState().site!.pages[0].nodes
    const rootChildren = nodes[rootId].children
    expect(rootChildren.indexOf(second!.rootIds[0])).toBe(rootChildren.indexOf(first!.rootIds[0]) + 1)
    expect(nodes[first!.rootIds[0]].children).not.toContain(second!.rootIds[0])
  })

  it("an explicit placement goes inside the selected container ('inside-selection') or to the end ('end')", () => {
    const site = useEditorStore.getState().createSite('Target')
    const rootId = site.pages[0].rootNodeId
    const first = useEditorStore.getState().insertFragment(resolvedPlanForStore(section))!
    const firstId = first.rootIds[0]

    const inside = useEditorStore.getState().insertFragment(resolvedPlanForStore(section), 'inside-selection')!
    let nodes = useEditorStore.getState().site!.pages[0].nodes
    expect(nodes[firstId].children.at(-1)).toBe(inside.rootIds[0])

    const second = useEditorStore.getState().insertFragment(resolvedPlanForStore(section), 'after-selection')!
    useEditorStore.getState().selectNode(firstId)
    const end = useEditorStore.getState().insertFragment(resolvedPlanForStore(section), 'end')!
    nodes = useEditorStore.getState().site!.pages[0].nodes
    expect(nodes[rootId].children).toEqual([firstId, end.rootIds[0]])
    // 'after-selection' with the nested section selected lands next to it, inside the first.
    expect(nodes[firstId].children.slice(-2)).toEqual([inside.rootIds[0], second.rootIds[0]])
  })

  it("never duplicates the seeded font role tokens of a new site", () => {
    useEditorStore.getState().createSite('Target')
    const before = useEditorStore.getState().site!.settings.fonts?.tokens?.map((t) => t.variable) ?? []
    expect(before).toContain('font-heading')
    useEditorStore.getState().insertFragment(resolvedPlanForStore(section))
    const after = useEditorStore.getState().site!.settings.fonts?.tokens?.map((t) => t.variable) ?? []
    expect(after).toEqual(before)
  })

  it('one undo removes the whole insert', () => {
    const site = useEditorStore.getState().createSite('Target')
    const before = useEditorStore.getState().site!
    const resolved = resolvedPlanForStore(section)
    useEditorStore.getState().insertFragment(resolved)

    useEditorStore.getState().undo()
    const undone = useEditorStore.getState().site!
    expect(undone.pages[0].nodes).toEqual(before.pages[0].nodes)
    expect(Object.keys(undone.styleRules).sort()).toEqual(Object.keys(before.styleRules).sort())
    expect(undone.visualComponents).toEqual([])
    expect(undone.settings.framework).toEqual(before.settings.framework)
    expect(undone.pages[0].nodes[site.pages[0].rootNodeId].children).toEqual([])
  })

  it('refuses a plan made for another document', () => {
    useEditorStore.getState().createSite('Target')
    const resolved = resolvedPlanForStore(section)
    expect(useEditorStore.getState().insertFragment({ ...resolved, document: { kind: 'page', pageId: 'elsewhere' } })).toBeNull()
  })

  it('a page fragment adds a page', async () => {
    useEditorStore.getState().createSite('Target')
    const { fragment } = await extractFromSource({ pageId: 'page-about' })
    const result = useEditorStore.getState().insertFragment(resolvedPlanForStore(fragment))
    const page = useEditorStore.getState().site!.pages.find((p) => p.id === result?.pageId)
    expect(page?.slug).toBe('about')
  })
})
