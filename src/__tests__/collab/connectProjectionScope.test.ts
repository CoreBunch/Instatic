/**
 * Connecting the provider — how often the site is re-assembled.
 *
 * Every doc of the loaded site binds at connect time and syncs in its own
 * socket message. A row doc's sync projects that row in place; it must not
 * also re-assemble the whole site when the store already holds the row.
 * Re-assembling once per row doc ran the full shell projection and its store
 * fan-out per page on load — seconds of blocked main thread and hundreds of
 * megabytes of garbage on a large site, enough to crash the renderer. A row
 * the store does NOT hold (a peer created it; the roster projection bound
 * its doc on demand) still re-assembles the site once its content arrives.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import {
  connectCollabProvider,
  disconnectCollabProvider,
} from '@site/store/slices/site/collabBinding'
import type {
  BoundCollabDoc,
  CollabProvider,
  CollabResetListener,
} from '@site/collab/collabProvider'
import { useEditorStore } from '@site/store/store'
import { parseCollabDocId, seedPageDoc, seedSiteDoc } from '@core/collab'
import type { Page, SiteDocument } from '@core/page-tree'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

function pageFixture(id: string): Page {
  return makePage({
    id,
    slug: id,
    title: id,
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: [`${id}-t`] }),
      [`${id}-t`]: makeNode({ id: `${id}-t`, moduleId: 'base.text', props: { text: id, tag: 'p' } }),
    },
  })
}

/**
 * Provider whose docs hold the server's content (seeded from `serverSite`)
 * and stay unsynced until the test releases each one — like socket messages
 * arriving one task apart.
 */
function seededDeferredProvider(serverSite: SiteDocument): CollabProvider & { release: (docId: string) => void } {
  const presenceDoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(presenceDoc)
  const bound = new Map<string, BoundCollabDoc & { release: () => void }>()
  const resetListeners = new Set<CollabResetListener>()
  return {
    bind: (docId) => {
      let entry = bound.get(docId)
      if (!entry) {
        const doc = new Y.Doc()
        const parsed = parseCollabDocId(docId)!
        if (parsed.kind === 'site') seedSiteDoc(doc, serverSite)
        else if (parsed.kind === 'page') seedPageDoc(doc, serverSite.pages.find((p) => p.id === parsed.rowId)!)
        let resolve = (): void => {}
        const whenSynced = new Promise<void>((r) => { resolve = () => r() })
        const created = { doc, synced: false, whenSynced, release: () => { created.synced = true; resolve() } }
        entry = created
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
    release: (docId) => {
      const entry = bound.get(docId)
      if (!entry) throw new Error(`not bound: ${docId}`)
      entry.release()
    },
    destroy: () => {
      awareness.destroy()
      presenceDoc.destroy()
    },
  }
}

/** One macrotask: the whenSynced continuation and the projection microtask both run. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  disconnectCollabProvider()
  useEditorStore.getState().clearSite()
})

describe('connectCollabProvider — site re-assembly scope', () => {
  it('re-assembles the site once for its own sync, not once per row doc the store already holds; a row it lacks re-assembles when it arrives', async () => {
    const loaded = makeSite({ pages: ['p1', 'p2', 'p3', 'p4'].map(pageFixture) })
    // The server knows one more page than the HTTP-loaded site: a peer created it.
    const server: SiteDocument = { ...loaded, pages: [...loaded.pages, pageFixture('p-extra')] }
    useEditorStore.getState().loadSite(loaded)

    // A site re-assembly replaces the shell (a fresh `styleRules` object); a row
    // projection keeps it (`{ ...site, pages }`). Count shell replacements.
    let shellReplacements = 0
    const unsubscribe = useEditorStore.subscribe(
      (s) => s.site?.styleRules,
      () => { shellReplacements++ },
    )

    const provider = seededDeferredProvider(server)
    connectCollabProvider(provider)

    provider.release('site:default')
    await nextTask()
    expect(shellReplacements).toBe(1)
    // The unknown roster member was bound on demand but is not synced yet.
    expect(useEditorStore.getState().site!.pages.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4'])

    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      provider.release(`page:${id}`)
      await nextTask()
    }
    expect(shellReplacements).toBe(1)
    expect(useEditorStore.getState().site!.pages.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4'])

    provider.release('page:p-extra')
    await nextTask()
    expect(shellReplacements).toBe(2)
    expect(useEditorStore.getState().site!.pages.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p-extra'])

    unsubscribe()
  })
})
