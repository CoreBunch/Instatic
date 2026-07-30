/**
 * whenCollabWritable — the gate a programmatic caller waits on.
 *
 * A newly bound doc is unsynced for a moment, and `applyLocalSitePatches`
 * refuses every site write while any doc is in that state. Interactive editing
 * never notices; a tool chain that creates a page and immediately fills it hits
 * the window nearly every time, and used to get a success result for a
 * mutation the relay never received.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import {
  connectCollabProvider,
  disconnectCollabProvider,
} from '@site/store/slices/site/collabBinding'
import { whenCollabWritable } from '@site/store/slices/site/collabWriteGate'
import type {
  BoundCollabDoc,
  CollabProvider,
  CollabResetListener,
} from '@site/collab/collabProvider'
import { useEditorStore } from '@site/store/store'
import '@modules/base/index'

/** Provider whose docs stay unsynced until the test releases them. */
function deferredProvider(): CollabProvider & { releaseAll: () => void } {
  const presenceDoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(presenceDoc)
  const bound = new Map<string, BoundCollabDoc>()
  const releases: Array<() => void> = []
  const resetListeners = new Set<CollabResetListener>()
  return {
    bind: (docId) => {
      let entry = bound.get(docId)
      if (!entry) {
        let release = (): void => {}
        const whenSynced = new Promise<void>((resolve) => { release = () => resolve() })
        entry = { doc: new Y.Doc(), synced: false, whenSynced }
        releases.push(() => {
          entry!.synced = true
          release()
        })
        bound.set(docId, entry)
      }
      return entry
    },
    unbind: (docId) => {
      bound.get(docId)?.doc.destroy()
      bound.delete(docId)
    },
    awareness,
    status: () => 'connected',
    canSend: () => true,
    reconnectNow: () => {},
    onStatus: () => () => {},
    onReset: (listener) => {
      resetListeners.add(listener)
      return () => resetListeners.delete(listener)
    },
    releaseAll: () => { for (const release of releases) release() },
    destroy: () => {
      awareness.destroy()
      presenceDoc.destroy()
    },
  }
}

afterEach(() => {
  disconnectCollabProvider()
  // These tests load a site into the shared editor store; leaving it behind
  // leaks into every later suite that reads the same singleton.
  useEditorStore.getState().clearSite()
})

describe('whenCollabWritable', () => {
  it('resolves immediately when no provider is connected', async () => {
    expect(await whenCollabWritable(50)).toBe(true)
  })

  it('waits for an unsynced doc and resolves once it syncs', async () => {
    // A loaded site is what binds docs; an empty workspace has nothing to gate.
    useEditorStore.getState().createSite('Gate Site')
    const provider = deferredProvider()
    connectCollabProvider(provider)

    let settled = false
    const gate = whenCollabWritable(5_000).then((ok) => { settled = true; return ok })

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(settled).toBe(false)

    provider.releaseAll()
    expect(await gate).toBe(true)
  })

  it('reports failure rather than hanging when sync never arrives', async () => {
    useEditorStore.getState().createSite('Stuck Site')
    connectCollabProvider(deferredProvider())
    expect(await whenCollabWritable(120)).toBe(false)
  })
})
