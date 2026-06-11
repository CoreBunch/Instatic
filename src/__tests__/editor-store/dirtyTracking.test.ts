/**
 * Patch-derived save-dirty tracking (slices/site/dirtyTracking.ts).
 *
 * Unit half: collectDirtyFromSitePatches resolves site-relative Mutative
 * patch paths to page / Visual Component ids against the POST-mutation site,
 * escalating anything unattributable to `all` (over-marking is safe,
 * under-marking loses edits).
 *
 * Store half: the real editor store wires the collector into
 * runHistoricMutation, undo/redo, the lifecycle resets, and the
 * `_dirtySave` snapshot/restore actions consumed by autosave.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import type { Patches } from 'mutative'
import { useEditorStore } from '@site/store/store'
import {
  collectDirtyFromSitePatches,
  emptyDirtyMarks,
  mergeDirtyMarks,
  type DirtyMarks,
} from '@site/store/slices/site/dirtyTracking'
import { makePage, makeSite, makeVC } from '../fixtures'

// ---------------------------------------------------------------------------
// Unit: collectDirtyFromSitePatches
// ---------------------------------------------------------------------------

function twoPageTwoVcSite() {
  return makeSite({
    pages: [
      makePage({ id: 'page-a', slug: 'index', title: 'Home' }),
      makePage({ id: 'page-b', slug: 'about', title: 'About' }),
    ],
    visualComponents: [
      makeVC({ id: 'vc-one', name: 'One' }),
      makeVC({ id: 'vc-two', name: 'Two' }),
    ],
  })
}

describe('collectDirtyFromSitePatches', () => {
  it('attributes a nested page edit to that page id', () => {
    const site = twoPageTwoVcSite()
    const patches: Patches = [
      { op: 'replace', path: ['pages', 1, 'nodes', 'root', 'props', 'text'], value: 'x' },
    ]
    const marks = collectDirtyFromSitePatches(patches, site)
    expect(marks.all).toBe(false)
    expect([...marks.pageIds]).toEqual(['page-b'])
    expect(marks.componentIds.size).toBe(0)
  })

  it('attributes a VC tree edit to that component id', () => {
    const site = twoPageTwoVcSite()
    const patches: Patches = [
      { op: 'replace', path: ['visualComponents', 0, 'tree', 'nodes', 'vc-root', 'props', 'x'], value: 1 },
    ]
    const marks = collectDirtyFromSitePatches(patches, site)
    expect(marks.all).toBe(false)
    expect(marks.pageIds.size).toBe(0)
    expect([...marks.componentIds]).toEqual(['vc-one'])
  })

  it('marks nothing for a remove at exactly [pages, i] — the roster conveys deletions', () => {
    const site = twoPageTwoVcSite()
    const patches: Patches = [{ op: 'remove', path: ['pages', 1] }]
    const marks = collectDirtyFromSitePatches(patches, site)
    expect(marks).toEqual(emptyDirtyMarks())
  })

  it('marks nothing for a remove at exactly [visualComponents, i]', () => {
    const site = twoPageTwoVcSite()
    const patches: Patches = [{ op: 'remove', path: ['visualComponents', 1] }]
    const marks = collectDirtyFromSitePatches(patches, site)
    expect(marks).toEqual(emptyDirtyMarks())
  })

  it('escalates a wholesale [pages] replacement to all', () => {
    const site = twoPageTwoVcSite()
    const patches: Patches = [{ op: 'replace', path: ['pages'], value: site.pages }]
    const marks = collectDirtyFromSitePatches(patches, site)
    expect(marks.all).toBe(true)
  })

  it('marks nothing for [pages, length] array bookkeeping', () => {
    const site = twoPageTwoVcSite()
    const patches: Patches = [{ op: 'replace', path: ['pages', 'length'], value: 1 }]
    const marks = collectDirtyFromSitePatches(patches, site)
    expect(marks).toEqual(emptyDirtyMarks())
  })

  it('escalates an index that does not resolve in the post-state to all', () => {
    const site = twoPageTwoVcSite() // 2 pages — index 5 resolves to nothing
    const patches: Patches = [{ op: 'replace', path: ['pages', 5, 'title'], value: 'ghost' }]
    const marks = collectDirtyFromSitePatches(patches, site)
    expect(marks.all).toBe(true)
  })

  it('escalates a non-numeric, non-length second segment to all', () => {
    const site = twoPageTwoVcSite()
    const patches: Patches = [{ op: 'replace', path: ['pages', 'not-an-index'], value: 1 }]
    const marks = collectDirtyFromSitePatches(patches, site)
    expect(marks.all).toBe(true)
  })

  it('marks nothing for shell-field paths — the shell is always saved', () => {
    const site = twoPageTwoVcSite()
    const patches: Patches = [
      { op: 'replace', path: ['styleRules', 'x'], value: {} },
      { op: 'replace', path: ['name'], value: 'Renamed' },
      { op: 'replace', path: ['updatedAt'], value: 123 },
    ]
    const marks = collectDirtyFromSitePatches(patches, site)
    expect(marks).toEqual(emptyDirtyMarks())
  })

  it('attributes an element add at [pages, i] to the added page', () => {
    const site = twoPageTwoVcSite()
    const patches: Patches = [{ op: 'add', path: ['pages', 1], value: site.pages[1] }]
    const marks = collectDirtyFromSitePatches(patches, site)
    expect(marks.all).toBe(false)
    expect([...marks.pageIds]).toEqual(['page-b'])
  })

  it('accumulates marks across a mixed patch set', () => {
    const site = twoPageTwoVcSite()
    const patches: Patches = [
      { op: 'replace', path: ['pages', 0, 'title'], value: 'New Home' },
      { op: 'replace', path: ['visualComponents', 1, 'name'], value: 'Two v2' },
      { op: 'replace', path: ['styleRules', 'r1'], value: {} },
    ]
    const marks = collectDirtyFromSitePatches(patches, site)
    expect(marks.all).toBe(false)
    expect([...marks.pageIds]).toEqual(['page-a'])
    expect([...marks.componentIds]).toEqual(['vc-two'])
  })
})

describe('mergeDirtyMarks', () => {
  it('unions ids and propagates the all flag', () => {
    const target: DirtyMarks = {
      all: false,
      pageIds: new Set(['page-a']),
      componentIds: new Set(['vc-one']),
      layoutIds: new Set(),
    }
    mergeDirtyMarks(target, {
      all: false,
      pageIds: new Set(['page-b']),
      componentIds: new Set(),
      layoutIds: new Set(),
    })
    expect(target.all).toBe(false)
    expect([...target.pageIds].sort()).toEqual(['page-a', 'page-b'])
    expect([...target.componentIds]).toEqual(['vc-one'])

    mergeDirtyMarks(target, { ...emptyDirtyMarks(), all: true })
    expect(target.all).toBe(true)
    // Existing ids survive an all-merge — `all` is a flag, not a reset.
    expect([...target.pageIds].sort()).toEqual(['page-a', 'page-b'])
  })

  it('never clears all once set, even when incoming is partial', () => {
    const target: DirtyMarks = { ...emptyDirtyMarks(), all: true }
    mergeDirtyMarks(target, { all: false, pageIds: new Set(['page-a']), componentIds: new Set(), layoutIds: new Set() })
    expect(target.all).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Store integration: the real editor store
// ---------------------------------------------------------------------------

function freshStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
    _dirtySave: emptyDirtyMarks(),
  } as Parameters<typeof useEditorStore.setState>[0])
}

function dirty(): DirtyMarks {
  return useEditorStore.getState()._dirtySave
}

function loadTwoPageSite() {
  useEditorStore.getState().loadSite(
    makeSite({
      pages: [
        makePage({ id: 'page-a', slug: 'index', title: 'Home' }),
        makePage({ id: 'page-b', slug: 'about', title: 'About' }),
      ],
      visualComponents: [makeVC({ id: 'vc-card', name: 'Card' })],
    }),
  )
}

describe('editor store dirty-save tracking', () => {
  beforeEach(freshStore)

  it('loadSite starts with empty marks', () => {
    loadTwoPageSite()
    expect(dirty()).toEqual(emptyDirtyMarks())
  })

  it('updateNodeProps on the active page marks exactly that page', () => {
    loadTwoPageSite()
    // loadSite activates the home page (slug `index`) — page-a.
    expect(useEditorStore.getState().activePageId).toBe('page-a')

    useEditorStore.getState().updateNodeProps('root', { text: 'hello' })

    const marks = dirty()
    expect(marks.all).toBe(false)
    expect([...marks.pageIds]).toEqual(['page-a'])
    expect(marks.componentIds.size).toBe(0)
  })

  it('editing a VC tree in VC canvas mode marks exactly that component', () => {
    loadTwoPageSite()
    useEditorStore.getState().setActiveDocument({ kind: 'visualComponent', vcId: 'vc-card' })

    useEditorStore.getState().updateNodeProps('vc-root', { padding: '8px' })

    const marks = dirty()
    expect(marks.all).toBe(false)
    expect(marks.pageIds.size).toBe(0)
    expect([...marks.componentIds]).toEqual(['vc-card'])
  })

  it('takeDirtySaveSnapshot returns the accumulated marks AND resets the accumulator', () => {
    loadTwoPageSite()
    useEditorStore.getState().updateNodeProps('root', { text: 'hello' })

    const snapshot = useEditorStore.getState().takeDirtySaveSnapshot()

    expect([...snapshot.pageIds]).toEqual(['page-a'])
    expect(snapshot.all).toBe(false)
    expect(dirty()).toEqual(emptyDirtyMarks())

    // The snapshot is an independent copy — mutating it cannot poison the store.
    snapshot.pageIds.add('page-injected')
    expect(dirty().pageIds.size).toBe(0)
  })

  it('undo after a snapshot re-marks the restored page', () => {
    loadTwoPageSite()
    useEditorStore.getState().updateNodeProps('root', { text: 'hello' })
    useEditorStore.getState().takeDirtySaveSnapshot() // simulate a successful save
    expect(dirty()).toEqual(emptyDirtyMarks())

    useEditorStore.getState().undo()

    // The undone page differs from what storage now holds — it must re-save.
    expect([...dirty().pageIds]).toEqual(['page-a'])
    expect(dirty().all).toBe(false)
  })

  it('redo after a snapshot re-marks the replayed page', () => {
    loadTwoPageSite()
    useEditorStore.getState().updateNodeProps('root', { text: 'hello' })
    useEditorStore.getState().undo()
    useEditorStore.getState().takeDirtySaveSnapshot()

    useEditorStore.getState().redo()

    expect([...dirty().pageIds]).toEqual(['page-a'])
  })

  it('restoreDirtySaveSnapshot merges a failed save back into fresh marks', () => {
    loadTwoPageSite()
    useEditorStore.getState().updateNodeProps('root', { text: 'hello' })
    const snapshot = useEditorStore.getState().takeDirtySaveSnapshot()

    // While the (failed) save was in flight, the user edited page-b.
    useEditorStore.setState({ activePageId: 'page-b' })
    useEditorStore.getState().updateNodeProps('root', { text: 'other page' })
    expect([...dirty().pageIds]).toEqual(['page-b'])

    useEditorStore.getState().restoreDirtySaveSnapshot(snapshot)

    expect([...dirty().pageIds].sort()).toEqual(['page-a', 'page-b'])
    expect(dirty().all).toBe(false)
  })

  it('markAllDirtyForSave sets the conservative full-save flag', () => {
    loadTwoPageSite()
    useEditorStore.getState().markAllDirtyForSave()
    expect(dirty().all).toBe(true)
  })

  it('loadSite resets accumulated marks', () => {
    loadTwoPageSite()
    useEditorStore.getState().updateNodeProps('root', { text: 'hello' })
    expect(dirty().pageIds.size).toBe(1)

    loadTwoPageSite()
    expect(dirty()).toEqual(emptyDirtyMarks())
  })

  it('createSite resets marks to all=true — a brand-new site needs a full first save', () => {
    loadTwoPageSite()
    useEditorStore.getState().updateNodeProps('root', { text: 'hello' })

    useEditorStore.getState().createSite('Fresh Site')

    const marks = dirty()
    expect(marks.all).toBe(true)
    expect(marks.pageIds.size).toBe(0)
    expect(marks.componentIds.size).toBe(0)
  })

  it('clearSite resets marks to empty', () => {
    loadTwoPageSite()
    useEditorStore.getState().updateNodeProps('root', { text: 'hello' })

    useEditorStore.getState().clearSite()

    expect(dirty()).toEqual(emptyDirtyMarks())
  })

  it('addPage marks the created page (and only it)', () => {
    loadTwoPageSite()
    const newPage = useEditorStore.getState().addPage('Pricing', 'pricing')

    const marks = dirty()
    expect(marks.all).toBe(false)
    expect([...marks.pageIds]).toEqual([newPage.id])
    expect(marks.componentIds.size).toBe(0)
  })

  it('deletePage shrinks the roster and never marks the deleted page id', () => {
    loadTwoPageSite()
    // Delete the LAST page so no surviving element is displaced to a new index.
    useEditorStore.getState().deletePage('page-b')

    const state = useEditorStore.getState()
    expect(state.site!.pages.map((p) => p.id)).toEqual(['page-a'])
    // The deleted page must NOT appear as a changed page — its removal is
    // conveyed by the shrunken id roster the save always ships.
    expect(dirty().pageIds.has('page-b')).toBe(false)

    // `deletePage` splices in place, so Mutative emits a `remove` patch at
    // ['pages', i] — which the collector deliberately ignores (the shrunken
    // id roster conveys the deletion). No full-save escalation.
    expect(dirty().all).toBe(false)
    expect(dirty().pageIds.size).toBe(0)
  })

  it('a VC delete via splice does not escalate to all', () => {
    // Contrast with deletePage: the VC slice deletes via splice(idx, 1), so
    // the patches are index/length bookkeeping the collector can attribute.
    useEditorStore.getState().loadSite(
      makeSite({
        pages: [makePage({ id: 'page-a', slug: 'index' })],
        visualComponents: [
          makeVC({ id: 'vc-one', name: 'One' }),
          makeVC({ id: 'vc-two', name: 'Two' }),
        ],
      }),
    )

    // Delete the LAST component — no displaced survivors.
    useEditorStore.getState().deleteVisualComponent('vc-two')

    const state = useEditorStore.getState()
    expect(state.site!.visualComponents.map((vc) => vc.id)).toEqual(['vc-one'])
    expect(dirty().all).toBe(false)
    expect(dirty().componentIds.has('vc-two')).toBe(false)
  })

  it('shell-only mutations (site rename) accumulate no marks', () => {
    loadTwoPageSite()
    useEditorStore.getState().updateSiteName('Renamed Site')

    expect(useEditorStore.getState().site!.name).toBe('Renamed Site')
    expect(useEditorStore.getState().hasUnsavedChanges).toBe(true)
    expect(dirty()).toEqual(emptyDirtyMarks())
  })
})
