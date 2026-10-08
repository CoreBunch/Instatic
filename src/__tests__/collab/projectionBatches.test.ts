import { afterEach, expect, it } from 'bun:test'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import '@modules/base'
import { encodeCollabDocId, MAIN_SITE_DOC_ID, metaMap, seedPageDoc, seedSiteDoc } from '@core/collab'
import type { CollabProvider, BoundCollabDoc } from '@site/collab/collabProvider'
import { connectCollabProvider, disconnectCollabProvider } from '@site/store/slices/site/collabBinding'
import { whenCollabWritable } from '@site/store/slices/site/collabWriteGate'
import { clearCollabBlockNotice } from '@site/store/slices/site/collabNotices'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite } from '../fixtures'

function seededProvider(site: ReturnType<typeof makeSite>) {
  const presence = new Y.Doc()
  const awareness = new Awareness(presence)
  const bound = new Map<string, BoundCollabDoc>()
  const releases: Array<() => void> = []
  const provider: CollabProvider = {
    bind(id) {
      const existing = bound.get(id)
      if (existing) return existing
      const doc = new Y.Doc()
      if (id === MAIN_SITE_DOC_ID) seedSiteDoc(doc, site)
      else {
        const page = site.pages.find((p) => pageId(p.id) === id)
        if (page) seedPageDoc(doc, page)
      }
      let release = () => {}
      const whenSynced = new Promise<void>((resolve) => { release = resolve })
      const entry = { doc, synced: false, whenSynced }
      bound.set(id, entry)
      releases.push(() => { entry.synced = true; release() })
      return entry
    },
    unbind(id) { bound.get(id)?.doc.destroy(); bound.delete(id) },
    awareness,
    status: () => 'connected',
    canSend: () => true,
    reconnectNow() {},
    onStatus: () => () => {},
    onReset: () => () => {},
    destroy() {
      for (const entry of bound.values()) entry.doc.destroy()
      awareness.destroy()
      presence.destroy()
    },
  }
  return { provider, releaseAll: () => { for (const release of releases) release() } }
}

function pageId(id: string) {
  return encodeCollabDocId({ kind: 'page', branchId: 'main', rowId: id })
}

afterEach(() => {
  disconnectCollabProvider()
  useEditorStore.getState().clearSite()
  clearCollabBlockNotice()
})

it('commits an initial row burst once and opens writes only after its projection', async () => {
  const pages = Array.from({ length: 30 }, (_, i) => makePage({ id: `page-${i}`, slug: `page-${i}` }))
  const site = makeSite({ pages })
  useEditorStore.getState().loadSite(site)
  const { provider, releaseAll } = seededProvider(makeSite({
    pages: pages.map((p, i) => ({ ...p, title: `Server ${i}` })),
  }))
  connectCollabProvider(provider)
  let changes = 0
  const off = useEditorStore.subscribe((next, previous) => {
    if (next.site !== previous.site) changes++
  })
  try {
    releaseAll()
    await Promise.resolve()
    expect(await whenCollabWritable(1)).toBe(false)
    useEditorStore.getState().updateSiteName('Premature write')
    expect(useEditorStore.getState().site!.name).toBe(site.name)
    expect(await whenCollabWritable()).toBe(true)
    expect(changes).toBe(1)
    expect(useEditorStore.getState().site!.pages.map((p) => p.title)).toEqual(
      pages.map((_p, i) => `Server ${i}`),
    )
    // After startup a live peer edit still projects in the next microtask.
    metaMap(provider.bind(pageId(pages[0].id)).doc).set('title', 'Live edit')
    await Promise.resolve()
    expect(useEditorStore.getState().site!.pages[0].title).toBe('Live edit')
    expect(changes).toBe(2)
  } finally {
    off()
  }
})
