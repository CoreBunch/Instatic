/**
 * Save-conflict resolution + base-seq bookkeeping (multi-admin level A).
 *
 * Covers the store half of the conflict protocol:
 *   - seedBaseSeqs / commitSavedBaseSeqs — the conflict-detection bases every
 *     incremental save ships, seeded at load and bumped on success (deleted
 *     rows KEEP their entries so a resurrect-by-undo carries the right base),
 *   - resolveSaveConflictKeepMine — bumps the target's base seq so the next
 *     save overwrites as a stated decision; dirty marks stay untouched,
 *   - applyRemoteSnapshot — swaps the remote version in (or removes a
 *     remotely-deleted target), clears the target's dirty marks, syncs the
 *     base seq, clears the undo history, and — for Visual Components —
 *     propagates to consumer pages with REAL dirty marks (slot re-sync /
 *     ref-cascade removal).
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { emptyDirtyMarks } from '@site/store/slices/site/dirtyTracking'
import { makeNode, makePage, makeSite, makeVC } from '../fixtures'

function loadFixtureSite(overrides: Parameters<typeof makeSite>[0] = {}) {
  useEditorStore.getState().loadSite(makeSite(overrides))
}

beforeEach(() => {
  useEditorStore.getState().clearSite()
})

// ---------------------------------------------------------------------------
// Base-seq bookkeeping
// ---------------------------------------------------------------------------

describe('base-seq bookkeeping', () => {
  it('seedBaseSeqs replaces the maps wholesale', () => {
    loadFixtureSite()
    useEditorStore.getState().seedBaseSeqs({ 'page-1': 4, 'vc-1': 5 }, 6)
    expect(useEditorStore.getState().baseSeqs).toEqual({ 'page-1': 4, 'vc-1': 5 })
    expect(useEditorStore.getState().shellBaseSeq).toBe(6)

    useEditorStore.getState().seedBaseSeqs({ 'page-2': 9 }, 10)
    expect(useEditorStore.getState().baseSeqs).toEqual({ 'page-2': 9 })
    expect(useEditorStore.getState().shellBaseSeq).toBe(10)
  })

  it('commitSavedBaseSeqs (incremental) bumps exactly the shipped ids — deleted rows keep entries', () => {
    loadFixtureSite({ pages: [makePage({ id: 'page-a' }), makePage({ id: 'page-b', slug: 'b' })] })
    useEditorStore.getState().seedBaseSeqs({ 'page-a': 1, 'page-b': 1, 'vc-gone': 1 }, 1)

    const dirty = {
      ...emptyDirtyMarks(),
      pageIds: new Set(['page-a']),
      deletedComponentIds: new Set(['vc-gone']),
    }
    useEditorStore.getState().commitSavedBaseSeqs(useEditorStore.getState().site!, dirty, 7)

    const { baseSeqs, shellBaseSeq } = useEditorStore.getState()
    expect(baseSeqs['page-a']).toBe(7)
    // Deleted rows keep a base at the delete-save's seq: an undo that
    // resurrects the row must not read as a blind overwrite.
    expect(baseSeqs['vc-gone']).toBe(7)
    // Unshipped rows keep their old base.
    expect(baseSeqs['page-b']).toBe(1)
    expect(shellBaseSeq).toBe(7)
  })

  it('commitSavedBaseSeqs (replace) rebuilds the map from the shipped site', () => {
    loadFixtureSite({ pages: [makePage({ id: 'page-a' })] })
    useEditorStore.getState().seedBaseSeqs({ 'stale-row': 3 }, 3)

    useEditorStore.getState().commitSavedBaseSeqs(useEditorStore.getState().site!, undefined, 9)

    expect(useEditorStore.getState().baseSeqs).toEqual({ 'page-a': 9 })
    expect(useEditorStore.getState().shellBaseSeq).toBe(9)
  })

  it('a successful save clears pending conflicts', () => {
    loadFixtureSite()
    useEditorStore.getState().setSaveConflicts([{ table: 'pages', rowId: 'page-1', seq: 5 }])
    useEditorStore.getState().commitSavedBaseSeqs(useEditorStore.getState().site!, undefined, 9)
    expect(useEditorStore.getState().saveConflicts).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Keep mine
// ---------------------------------------------------------------------------

describe('resolveSaveConflictKeepMine', () => {
  it('bumps the row base to the remote seq and drops the conflict; dirty marks survive', () => {
    loadFixtureSite()
    useEditorStore.getState().seedBaseSeqs({ 'page-1': 2 }, 2)
    useEditorStore.setState((s) => {
      s._dirtySave.pageIds.add('page-1')
    })
    useEditorStore.getState().setSaveConflicts([{ table: 'pages', rowId: 'page-1', seq: 8 }])

    useEditorStore.getState().resolveSaveConflictKeepMine({ table: 'pages', rowId: 'page-1', seq: 8 })

    const state = useEditorStore.getState()
    expect(state.saveConflicts).toEqual([])
    expect(state.baseSeqs['page-1']).toBe(8)
    expect(state._dirtySave.pageIds.has('page-1')).toBe(true)
  })

  it('bumps the shell base for a site conflict', () => {
    loadFixtureSite()
    useEditorStore.getState().seedBaseSeqs({}, 2)
    useEditorStore.getState().setSaveConflicts([{ table: 'site', rowId: 'default', seq: 11 }])

    useEditorStore.getState().resolveSaveConflictKeepMine({ table: 'site', rowId: 'default', seq: 11 })

    expect(useEditorStore.getState().shellBaseSeq).toBe(11)
    expect(useEditorStore.getState().saveConflicts).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Load theirs
// ---------------------------------------------------------------------------

describe('applyRemoteSnapshot', () => {
  it('swaps a remote page in, clears its dirty marks, syncs the base seq, clears history', () => {
    loadFixtureSite({ pages: [makePage({ id: 'page-a', title: 'Mine' })] })
    useEditorStore.getState().seedBaseSeqs({ 'page-a': 1 }, 1)
    // Local unsaved edit — real history + dirty marks.
    useEditorStore.getState().renamePage('page-a', 'Mine (edited)')
    expect(useEditorStore.getState().canUndo).toBe(true)
    expect(useEditorStore.getState()._dirtySave.pageIds.has('page-a')).toBe(true)
    useEditorStore.getState().setSaveConflicts([{ table: 'pages', rowId: 'page-a', seq: 6 }])

    useEditorStore.getState().applyRemoteSnapshot({
      table: 'pages',
      rowId: 'page-a',
      row: makePage({ id: 'page-a', title: 'Theirs' }),
      seq: 6,
    })

    const state = useEditorStore.getState()
    expect(state.site!.pages.find((p) => p.id === 'page-a')!.title).toBe('Theirs')
    expect(state._dirtySave.pageIds.has('page-a')).toBe(false)
    expect(state.baseSeqs['page-a']).toBe(6)
    expect(state.saveConflicts).toEqual([])
    // Site-relative history patches are undefined across a swapped tree.
    expect(state.canUndo).toBe(false)
    expect(state._historyPast).toEqual([])
  })

  it('removes a remotely-deleted page and moves the active page off it', () => {
    loadFixtureSite({
      pages: [
        makePage({ id: 'page-home', slug: 'index', title: 'Home' }),
        makePage({ id: 'page-b', slug: 'b', title: 'B' }),
      ],
    })
    useEditorStore.getState().seedBaseSeqs({ 'page-home': 1, 'page-b': 1 }, 1)
    useEditorStore.getState().setActivePage('page-b')

    useEditorStore.getState().applyRemoteSnapshot({
      table: 'pages',
      rowId: 'page-b',
      row: null,
      seq: 6,
    })

    const state = useEditorStore.getState()
    expect(state.site!.pages.map((p) => p.id)).toEqual(['page-home'])
    expect(state.activePageId).toBe('page-home')
    expect(state.baseSeqs['page-b']).toBeUndefined()
  })

  it('swaps remote shell fields in place, leaving the row collections untouched', () => {
    loadFixtureSite({ name: 'Mine', pages: [makePage({ id: 'page-a' })] })
    useEditorStore.getState().seedBaseSeqs({ 'page-a': 1 }, 1)
    const remoteShell = (() => {
      const { pages: _p, visualComponents: _v, layouts: _l, ...shell } = makeSite({ name: 'Theirs' })
      return shell
    })()

    useEditorStore.getState().applyRemoteSnapshot({
      table: 'site',
      shell: remoteShell,
      seq: 12,
    })

    const state = useEditorStore.getState()
    expect(state.site!.name).toBe('Theirs')
    expect(state.site!.pages.map((p) => p.id)).toEqual(['page-a'])
    expect(state.shellBaseSeq).toBe(12)
  })

  it('a remotely-deleted VC cascades ref removal into consumer pages WITH dirty marks', () => {
    const vc = makeVC({ id: 'vc-1', name: 'Card' })
    const page = makePage({
      id: 'page-a',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['ref-1'] }),
        'ref-1': makeNode({
          id: 'ref-1',
          moduleId: 'base.visual-component-ref',
          props: { componentId: 'vc-1' },
        }),
      },
    })
    loadFixtureSite({ pages: [page], visualComponents: [vc] })
    useEditorStore.getState().seedBaseSeqs({ 'page-a': 1, 'vc-1': 1 }, 1)
    useEditorStore.getState().setSaveConflicts([{ table: 'components', rowId: 'vc-1', seq: 4 }])

    useEditorStore.getState().applyRemoteSnapshot({
      table: 'components',
      rowId: 'vc-1',
      row: null,
      seq: 4,
    })

    const state = useEditorStore.getState()
    expect(state.site!.visualComponents).toEqual([])
    // The consumer page lost its ref node…
    expect(state.site!.pages[0].nodes['ref-1']).toBeUndefined()
    // …and now DIFFERS from storage, so it must ship with the next save.
    expect(state._dirtySave.pageIds.has('page-a')).toBe(true)
    expect(state.baseSeqs['vc-1']).toBeUndefined()
    expect(state.saveConflicts).toEqual([])
  })
})
