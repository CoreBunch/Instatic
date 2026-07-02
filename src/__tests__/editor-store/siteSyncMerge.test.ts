/**
 * Live-pull merge policy (multi-admin level B) — processSiteSyncEvent.
 *
 * The rule, per event target:
 *   1. base seq ≥ event seq → skipped entirely (own-save echo, no fetch),
 *   2. dirty locally → pending conflict, content untouched,
 *   3. clean → fetch + applyRemoteSnapshot; identical content (echo that
 *      outran the save response) is bookkeeping-only and PRESERVES history;
 *      genuinely newer content swaps in and clears history,
 *   4. dirtiness is re-checked after the fetch — an edit landing mid-wire
 *      degrades to a conflict, never a silent overwrite.
 *
 * Plus: the shell path keys off the dedicated `shell` dirty mark, deletions
 * remove rows, and the cursor advances with every processed event. The
 * snapshot fetch is injected (`SiteSyncMergeDeps`) so no HTTP or module
 * mocking is involved.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import type { Page } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { processSiteSyncEvent, type SiteSyncMergeDeps } from '@site/hooks/siteSyncMerge'
import type { RemoteSnapshot } from '@site/store/slices/site/types'
import { makePage, makeSite } from '../fixtures'

function depsReturning(snapshot: RemoteSnapshot): SiteSyncMergeDeps & { calls: number } {
  const deps = {
    calls: 0,
    fetchSnapshot: async () => {
      deps.calls += 1
      return snapshot
    },
  }
  return deps
}

function depsThatMustNotFetch(): SiteSyncMergeDeps {
  return {
    fetchSnapshot: () => {
      throw new Error('fetchSnapshot must not be called for this event')
    },
  }
}

function loadTwoPageSite(): void {
  useEditorStore.getState().loadSite(
    makeSite({
      pages: [
        makePage({ id: 'page-a', slug: 'index', title: 'Home' }),
        makePage({ id: 'page-b', slug: 'about', title: 'About' }),
      ],
    }),
  )
  useEditorStore.getState().seedBaseSeqs({ 'page-a': 5, 'page-b': 5 }, 5)
}

function remotePage(title: string): Page {
  return makePage({ id: 'page-a', slug: 'index', title })
}

beforeEach(() => {
  useEditorStore.getState().clearSite()
})

describe('processSiteSyncEvent — rows-changed', () => {
  it('applies a newer remote row to a clean target and advances the cursor', async () => {
    loadTwoPageSite()
    const deps = depsReturning({
      table: 'pages',
      rowId: 'page-a',
      row: remotePage('Home (remote v2)'),
      seq: 9,
    })

    await processSiteSyncEvent(
      { kind: 'rows-changed', table: 'pages', seqs: { 'page-a': 9 } },
      deps,
    )

    const state = useEditorStore.getState()
    expect(deps.calls).toBe(1)
    expect(state.site!.pages.find((p) => p.id === 'page-a')!.title).toBe('Home (remote v2)')
    expect(state.baseSeqs['page-a']).toBe(9)
    expect(state.syncCursor).toBe(9)
    expect(state.saveConflicts).toEqual([])
  })

  it('skips events at or below the base seq without fetching (own-save echo, fast path)', async () => {
    loadTwoPageSite()
    await processSiteSyncEvent(
      { kind: 'rows-changed', table: 'pages', seqs: { 'page-a': 5 } },
      depsThatMustNotFetch(),
    )
    expect(useEditorStore.getState().site!.pages[0].title).toBe('Home')
  })

  it('degrades to a pending conflict when the target is dirty locally — content untouched, no fetch', async () => {
    loadTwoPageSite()
    useEditorStore.getState().renamePage('page-a', 'Home (my edit)')

    await processSiteSyncEvent(
      { kind: 'rows-changed', table: 'pages', seqs: { 'page-a': 9 } },
      depsThatMustNotFetch(),
    )

    const state = useEditorStore.getState()
    expect(state.saveConflicts).toEqual([{ table: 'pages', rowId: 'page-a', seq: 9 }])
    expect(state.site!.pages.find((p) => p.id === 'page-a')!.title).toBe('Home (my edit)')
    // The conflict does not stop the cursor — the pending entry carries the info.
    expect(state.syncCursor).toBe(9)
  })

  it('re-checks dirtiness AFTER the fetch — an edit landing mid-wire becomes a conflict, not an overwrite', async () => {
    loadTwoPageSite()
    const deps: SiteSyncMergeDeps = {
      fetchSnapshot: async () => {
        // The user edits while the fetch is on the wire.
        useEditorStore.getState().renamePage('page-a', 'Home (raced edit)')
        return { table: 'pages', rowId: 'page-a', row: remotePage('Home (remote)'), seq: 9 }
      },
    }

    await processSiteSyncEvent(
      { kind: 'rows-changed', table: 'pages', seqs: { 'page-a': 9 } },
      deps,
    )

    const state = useEditorStore.getState()
    expect(state.site!.pages.find((p) => p.id === 'page-a')!.title).toBe('Home (raced edit)')
    expect(state.saveConflicts).toEqual([{ table: 'pages', rowId: 'page-a', seq: 9 }])
  })

  it('an echo with identical content is bookkeeping-only — undo history survives', async () => {
    loadTwoPageSite()
    // Real local history on ANOTHER page — must survive the echo.
    useEditorStore.getState().renamePage('page-b', 'About (edited)')
    expect(useEditorStore.getState().canUndo).toBe(true)

    // The fetched remote page-a equals the local one byte-for-byte.
    const local = useEditorStore.getState().site!.pages.find((p) => p.id === 'page-a')!
    const deps = depsReturning({
      table: 'pages',
      rowId: 'page-a',
      row: structuredClone(local) as Page,
      seq: 9,
    })

    await processSiteSyncEvent(
      { kind: 'rows-changed', table: 'pages', seqs: { 'page-a': 9 } },
      deps,
    )

    const state = useEditorStore.getState()
    expect(state.canUndo).toBe(true) // history preserved
    expect(state.baseSeqs['page-a']).toBe(9) // bookkeeping synced
  })
})

describe('processSiteSyncEvent — rows-deleted', () => {
  it('removes a remotely-deleted clean row without any fetch', async () => {
    loadTwoPageSite()
    await processSiteSyncEvent(
      { kind: 'rows-deleted', table: 'pages', seqs: { 'page-b': 9 } },
      depsThatMustNotFetch(),
    )

    const state = useEditorStore.getState()
    expect(state.site!.pages.map((p) => p.id)).toEqual(['page-a'])
    expect(state.baseSeqs['page-b']).toBeUndefined()
    expect(state.syncCursor).toBe(9)
  })

  it('a remote deletion of a locally-DIRTY row becomes a conflict', async () => {
    loadTwoPageSite()
    useEditorStore.getState().renamePage('page-b', 'About (my edit)')

    await processSiteSyncEvent(
      { kind: 'rows-deleted', table: 'pages', seqs: { 'page-b': 9 } },
      depsThatMustNotFetch(),
    )

    const state = useEditorStore.getState()
    expect(state.site!.pages).toHaveLength(2)
    expect(state.saveConflicts).toEqual([{ table: 'pages', rowId: 'page-b', seq: 9 }])
  })
})

describe('processSiteSyncEvent — shell-changed', () => {
  it('applies a remote shell when the local shell is untouched', async () => {
    loadTwoPageSite()
    const { pages: _p, visualComponents: _v, layouts: _l, ...shell } = makeSite({
      name: 'Renamed remotely',
    })
    const deps = depsReturning({ table: 'site', shell, seq: 9 })

    await processSiteSyncEvent({ kind: 'shell-changed', seq: 9 }, deps)

    const state = useEditorStore.getState()
    expect(state.site!.name).toBe('Renamed remotely')
    expect(state.shellBaseSeq).toBe(9)
    expect(state.syncCursor).toBe(9)
  })

  it('a dirty local shell degrades to a conflict — the dedicated shell mark gates it', async () => {
    loadTwoPageSite()
    // A shell-field mutation sets the shell dirty mark via patch tracking.
    useEditorStore.getState().updateSiteName('Renamed locally')
    expect(useEditorStore.getState()._dirtySave.shell).toBe(true)

    await processSiteSyncEvent({ kind: 'shell-changed', seq: 9 }, depsThatMustNotFetch())

    const state = useEditorStore.getState()
    expect(state.site!.name).toBe('Renamed locally')
    expect(state.saveConflicts).toEqual([{ table: 'site', rowId: 'default', seq: 9 }])
  })

  it('a page edit does NOT mark the shell dirty — sibling shell changes still apply live', async () => {
    loadTwoPageSite()
    useEditorStore.getState().renamePage('page-a', 'Home (edited)')
    expect(useEditorStore.getState()._dirtySave.shell).toBe(false)
  })
})

describe('processSiteSyncEvent — conflict dedupe', () => {
  it('repeated events for the same dirty target keep ONE pending conflict at the newest seq', async () => {
    loadTwoPageSite()
    useEditorStore.getState().renamePage('page-a', 'Home (my edit)')

    await processSiteSyncEvent(
      { kind: 'rows-changed', table: 'pages', seqs: { 'page-a': 9 } },
      depsThatMustNotFetch(),
    )
    await processSiteSyncEvent(
      { kind: 'rows-changed', table: 'pages', seqs: { 'page-a': 12 } },
      depsThatMustNotFetch(),
    )

    expect(useEditorStore.getState().saveConflicts).toEqual([
      { table: 'pages', rowId: 'page-a', seq: 12 },
    ])
  })
})

describe('processSiteSyncEvent — aligned deletions', () => {
  it('a remote deletion of a row this editor ALSO deleted merges silently (agreement, not conflict)', async () => {
    loadTwoPageSite()
    useEditorStore.getState().deletePage('page-b')
    expect(useEditorStore.getState()._dirtySave.deletedPageIds.has('page-b')).toBe(true)

    await processSiteSyncEvent(
      { kind: 'rows-deleted', table: 'pages', seqs: { 'page-b': 9 } },
      depsThatMustNotFetch(),
    )

    const state = useEditorStore.getState()
    expect(state.saveConflicts).toEqual([])
    // The now-moot local deletion mark is cleared — nothing left to ship.
    expect(state._dirtySave.deletedPageIds.has('page-b')).toBe(false)
    expect(state.baseSeqs['page-b']).toBeUndefined()
  })
})
