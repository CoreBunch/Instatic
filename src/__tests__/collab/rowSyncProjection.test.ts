import { afterEach, expect, it } from 'bun:test'
import { waitFor } from '@testing-library/react'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import '@modules/base'
import { seedPageDoc, seedSiteDoc, MAIN_SITE_DOC_ID, encodeCollabDocId } from '@core/collab'
import { MAIN_BRANCH_ID } from '@core/branches'
import type { CollabProvider, BoundCollabDoc } from '@site/collab/collabProvider'
import { connectCollabProvider, disconnectCollabProvider } from '@site/store/slices/site/collabBinding'
import { useEditorStore } from '@site/store/store'
import { makePage, makeSite } from '../fixtures'

function makeProvider(site: ReturnType<typeof makeSite>) {
  const presence = new Y.Doc()
  const awareness = new Awareness(presence)
  const entries = new Map<string, BoundCollabDoc>()
  const releases = new Map<string, () => void>()
  const provider: CollabProvider = {
    bind(id) {
      const known = entries.get(id)
      if (known) return known
      const doc = new Y.Doc()
      if (id === MAIN_SITE_DOC_ID) seedSiteDoc(doc, site)
      else {
        const page = site.pages.find((p) => pageId(p.id) === id)
        if (page) seedPageDoc(doc, page)
      }
      let release = () => {}
      const whenSynced = new Promise<void>((resolve) => { release = resolve })
      const entry = { doc, synced: false, whenSynced }
      entries.set(id, entry)
      releases.set(id, () => { entry.synced = true; release() })
      return entry
    },
    unbind(id) { entries.get(id)?.doc.destroy(); entries.delete(id) },
    awareness,
    status: () => 'connected',
    canSend: () => true,
    reconnectNow() {},
    onStatus: () => () => {},
    onReset: () => () => {},
    destroy() {
      for (const entry of entries.values()) entry.doc.destroy()
      awareness.destroy()
      presence.destroy()
    },
  }
  return { provider, release: (id: string) => releases.get(id)?.() }
}

function pageId(id: string) {
  return encodeCollabDocId({ kind: 'page', branchId: MAIN_BRANCH_ID, rowId: id })
}

afterEach(() => {
  disconnectCollabProvider()
  useEditorStore.getState().clearSite()
})

it('syncs existing pages without replacing the already projected shell', async () => {
  const site = makeSite({ pages: [makePage(), makePage({ id: 'page-2', slug: 'second' })] })
  useEditorStore.setState({ site })
  const { provider, release } = makeProvider(site)
  connectCollabProvider(provider)
  release(MAIN_SITE_DOC_ID)
  await waitFor(() => expect(useEditorStore.getState().site!.settings).not.toBe(site.settings))
  const shell = useEditorStore.getState().site!.settings
  const initial = useEditorStore.getState().site!.pages[0]
  release(pageId('page-1'))
  await waitFor(() => expect(useEditorStore.getState().site!.pages[0]).not.toBe(initial))
  expect(useEditorStore.getState().site!.settings).toBe(shell)
  const second = useEditorStore.getState().site!.pages[1]
  release(pageId('page-2'))
  await waitFor(() => expect(useEditorStore.getState().site!.pages[1]).not.toBe(second))
  expect(useEditorStore.getState().site!.settings).toBe(shell)
})

it('assembles a newly discovered peer page in roster order after its doc syncs', async () => {
  const first = makePage()
  const peer = makePage({ id: 'peer-page', slug: 'peer' })
  const initialSite = makeSite({ pages: [first] })
  useEditorStore.setState({ site: initialSite })
  const { provider, release } = makeProvider(makeSite({ pages: [peer, first] }))
  connectCollabProvider(provider)
  release(MAIN_SITE_DOC_ID)
  await waitFor(() => expect(useEditorStore.getState().site!.settings).not.toBe(initialSite.settings))
  expect(useEditorStore.getState().site!.pages.map((p) => p.id)).toEqual([first.id])
  release(pageId(peer.id))
  await waitFor(() => expect(useEditorStore.getState().site!.pages.map((p) => p.id)).toEqual([peer.id, first.id]))
})
