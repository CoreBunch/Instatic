/**
 * usePersistence single-flight save queue.
 *
 * Every save trigger (autosave, Cmd+S, save-request events, the MCP bridge,
 * unmount flush) funnels through `saveCurrentSite`, which allows at most ONE
 * save on the wire and ONE queued follow-up:
 *
 *   - N triggers during an in-flight save coalesce into a single follow-up
 *     that reads the LATEST store state when it runs,
 *   - the follow-up is skipped when the in-flight save already shipped
 *     everything (no unsaved changes remain),
 *   - a FAILED in-flight save does not cancel the queued retry — its dirty
 *     marks were restored, so the retry ships them again.
 *
 * Two saves can therefore never interleave on the wire — the failure mode
 * the retired four-request protocol had.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import React, { useEffect } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { usePersistence } from '@site/hooks/usePersistence'
import type { IPersistenceAdapter, SaveSiteOptions } from '@core/persistence/types'
import type { SiteDocument } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { emptyDirtyMarks } from '@site/store/slices/site/dirtyTracking'
import { makePage, makeSite } from '../fixtures'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (err: unknown) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface RecordedSave {
  dirty: SaveSiteOptions['dirty']
  gate: Deferred
}

/** Adapter whose saveSite parks on a caller-controlled gate per invocation. */
function makeGatedAdapter(): { adapter: IPersistenceAdapter; saves: RecordedSave[] } {
  const saves: RecordedSave[] = []
  const adapter: IPersistenceAdapter = {
    loadSite: async () => undefined,
    saveSite: (_site: SiteDocument, opts: SaveSiteOptions = {}) => {
      const gate = deferred()
      saves.push({ dirty: opts.dirty, gate })
      return gate.promise
    },
  }
  return { adapter, saves }
}

/** Mounts usePersistence and hands the save callback out to the test. */
function HookHost({
  adapter,
  onSave,
}: {
  adapter: IPersistenceAdapter
  onSave: (save: () => Promise<void>) => void
}) {
  const { saveSite } = usePersistence('default', adapter, { enabled: true })
  useEffect(() => {
    onSave(saveSite)
  }, [onSave, saveSite])
  return null
}

function seedStore(): void {
  useEditorStore.setState({
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    hasUnsavedChanges: false,
    _dirtySave: emptyDirtyMarks(),
  } as Parameters<typeof useEditorStore.setState>[0])
  useEditorStore.getState().loadSite(
    makeSite({
      pages: [
        makePage({ id: 'page-a', slug: 'index', title: 'Home' }),
        makePage({ id: 'page-b', slug: 'about', title: 'About' }),
      ],
    }),
  )
}

async function mountHook(adapter: IPersistenceAdapter): Promise<() => Promise<void>> {
  let save: (() => Promise<void>) | null = null
  render(<HookHost adapter={adapter} onSave={(s) => { save = s }} />)
  await waitFor(() => expect(save).not.toBeNull())
  return save!
}

function editPage(pageId: string): void {
  const store = useEditorStore.getState()
  useEditorStore.setState({ activePageId: pageId })
  store.updateNodeProps('root', { text: `edit-${pageId}-${Math.random()}` })
}

afterEach(cleanup)

describe('usePersistence single-flight save queue', () => {
  it('coalesces N mid-flight triggers into ONE follow-up that ships the latest state', async () => {
    seedStore()
    const { adapter, saves } = makeGatedAdapter()
    const save = await mountHook(adapter)

    editPage('page-a')
    const first = save()
    await waitFor(() => expect(saves).toHaveLength(1))
    expect([...saves[0].dirty!.pageIds]).toEqual(['page-a'])

    // Three triggers while save #1 is on the wire — plus a NEW edit.
    editPage('page-b')
    const q1 = save()
    const q2 = save()
    const q3 = save()
    // All coalesce into one queued promise; nothing new on the wire yet.
    expect(saves).toHaveLength(1)

    saves[0].gate.resolve()
    await first

    await waitFor(() => expect(saves).toHaveLength(2))
    // The follow-up shipped the LATEST marks (page-b's edit).
    expect(saves[1].dirty!.pageIds.has('page-b')).toBe(true)

    saves[1].gate.resolve()
    await Promise.all([q1, q2, q3])
    // No third save — the queue drained.
    expect(saves).toHaveLength(2)
  })

  it('skips the queued follow-up when the in-flight save already shipped everything', async () => {
    seedStore()
    const { adapter, saves } = makeGatedAdapter()
    const save = await mountHook(adapter)

    editPage('page-a')
    const first = save()
    await waitFor(() => expect(saves).toHaveLength(1))

    // Trigger spam with NO new edits while save #1 is in flight.
    const q = save()
    saves[0].gate.resolve()
    await first
    await q

    // hasUnsavedChanges went false when save #1 landed — the follow-up is
    // pointless and must not fire.
    expect(saves).toHaveLength(1)
    expect(useEditorStore.getState().hasUnsavedChanges).toBe(false)
  })

  it('a failed in-flight save does not cancel the queued retry, and the retry re-ships the restored marks', async () => {
    seedStore()
    const { adapter, saves } = makeGatedAdapter()
    const save = await mountHook(adapter)

    editPage('page-a')
    const first = save()
    await waitFor(() => expect(saves).toHaveLength(1))

    editPage('page-b')
    const q = save()

    saves[0].gate.reject(new Error('network down'))
    await expect(first).rejects.toThrow('network down')

    // The retry fires and carries BOTH page-a (restored from the failed
    // snapshot) and page-b (the new edit).
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1].dirty!.pageIds.has('page-a')).toBe(true)
    expect(saves[1].dirty!.pageIds.has('page-b')).toBe(true)

    saves[1].gate.resolve()
    await q
    expect(useEditorStore.getState().hasUnsavedChanges).toBe(false)
  })

  it('a new trigger after the queue drained starts a fresh save', async () => {
    seedStore()
    const { adapter, saves } = makeGatedAdapter()
    const save = await mountHook(adapter)

    editPage('page-a')
    const first = save()
    await waitFor(() => expect(saves).toHaveLength(1))
    saves[0].gate.resolve()
    await first

    editPage('page-b')
    const second = save()
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1].dirty!.pageIds.has('page-b')).toBe(true)
    saves[1].gate.resolve()
    await second
  })
})
