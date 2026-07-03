/**
 * Peer presence — deterministic identity colors, local-state publishing,
 * docId-scoped peer filtering (with TypeBox validation of wire states), and
 * a smoke render of the canvas presence overlay against fake awareness
 * states.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { render, screen, cleanup, act } from '@testing-library/react'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { useEditorStore } from '@site/store/store'
import {
  activeEditorDocId,
  peerColor,
  usePeerPresences,
} from '@site/collab/awarenessState'
import {
  connectCollabProvider,
  disconnectCollabProvider,
} from '@site/store/slices/site/collabBinding'
import type { BoundCollabDoc, CollabProvider } from '@site/collab/collabProvider'
import { PeerPresenceOverlay } from '@admin/pages/site/canvas/PeerPresenceOverlay'
import '@modules/base/index'

/** Minimal provider stub: real Awareness, synced-on-bind docs, no transport. */
function fakeProvider(): CollabProvider & { awareness: awarenessProtocol.Awareness } {
  const presenceDoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(presenceDoc)
  const bound = new Map<string, BoundCollabDoc>()
  return {
    bind: (docId) => {
      let entry = bound.get(docId)
      if (!entry) {
        entry = { doc: new Y.Doc(), synced: true, whenSynced: Promise.resolve() }
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
    onStatus: () => () => {},
    onReset: () => () => {},
    destroy: () => {
      awareness.destroy()
      presenceDoc.destroy()
    },
  }
}

/** Inject a remote peer's presence into `target` the way the wire would. */
function injectPeerState(target: awarenessProtocol.Awareness, state: unknown): number {
  const peerDoc = new Y.Doc()
  const peer = new awarenessProtocol.Awareness(peerDoc)
  peer.setLocalState(state)
  const update = awarenessProtocol.encodeAwarenessUpdate(peer, [peer.clientID])
  awarenessProtocol.applyAwarenessUpdate(target, update, 'remote')
  return peer.clientID
}

function PeerList({ docId }: { docId: string | null }) {
  const peers = usePeerPresences(docId)
  return (
    <ul>
      {peers.map((peer) => (
        <li key={peer.clientId}>{peer.user.name}</li>
      ))}
    </ul>
  )
}

afterEach(() => {
  cleanup()
  disconnectCollabProvider()
  useEditorStore.getState().clearSite()
})

describe('peerColor', () => {
  it('is deterministic and HSL-formatted', () => {
    expect(peerColor('user-a')).toBe(peerColor('user-a'))
    expect(peerColor('user-a')).toMatch(/^hsl\(\d+ 70% 45%\)$/)
    expect(peerColor('user-a')).not.toBe(peerColor('user-b'))
  })
})

describe('activeEditorDocId', () => {
  it('routes VC mode to the component doc and page mode to the page doc', () => {
    expect(
      activeEditorDocId({ activeDocument: { kind: 'visualComponent', vcId: 'vc-1' }, activePageId: 'p1' }),
    ).toBe('component:vc-1')
    expect(activeEditorDocId({ activeDocument: null, activePageId: 'p1' })).toBe('page:p1')
    expect(activeEditorDocId({ activeDocument: null, activePageId: null })).toBeNull()
  })
})

describe('usePeerPresences', () => {
  it('returns peers on the same doc, drops other docs and malformed states', async () => {
    const provider = fakeProvider()
    connectCollabProvider(provider)

    render(<PeerList docId="page:p1" />)

    await act(async () => {
      injectPeerState(provider.awareness, {
        user: { id: 'u2', name: 'Ada', color: peerColor('u2'), avatarUrl: null, gravatarHash: null },
        docId: 'page:p1',
        selectedNodeIds: ['n1'],
        editingNodeId: null,
        pointer: null,
      })
      injectPeerState(provider.awareness, {
        user: { id: 'u3', name: 'Grace', color: peerColor('u3'), avatarUrl: null, gravatarHash: null },
        docId: 'page:OTHER',
        selectedNodeIds: [],
        editingNodeId: null,
        pointer: null,
      })
      // Malformed wire state — must be dropped by validation, not crash.
      injectPeerState(provider.awareness, { user: { id: 42 }, docId: 'page:p1' })
    })

    expect(screen.getByText('Ada')).toBeTruthy()
    expect(screen.queryByText('Grace')).toBeNull()
  })
})

describe('PeerPresenceOverlay', () => {
  it('module CSS never hides presence chrome by default (regression: invisible cursors)', () => {
    // The overlay positioning helpers hide with INLINE `display: none` and
    // show by CLEARING the inline value — a stylesheet `display: none`
    // default would make every cleared element fall back to hidden forever
    // (the bug that shipped rings/tags/cursors invisible). Presence chrome
    // must start visible and let the first RAF tick place or hide it.
    const { readFileSync } = require('fs') as typeof import('fs')
    const css = readFileSync(
      new URL('../../admin/pages/site/canvas/PeerPresenceOverlay.module.css', import.meta.url),
      'utf-8',
    )
    expect(css).not.toContain('display: none')
  })


  it('renders a name tag for a peer selection on the active page doc', async () => {
    const provider = fakeProvider()
    connectCollabProvider(provider)

    // The overlay derives its docId from the store's active page.
    const site = useEditorStore.getState().createSite('Presence Site')
    const pageId = site.pages[0].id
    useEditorStore.setState({ activePageId: pageId })

    render(<PeerPresenceOverlay breakpointId="bp-desktop" iframeElement={null} />)

    await act(async () => {
      injectPeerState(provider.awareness, {
        user: { id: 'u9', name: 'Marge', color: peerColor('u9'), avatarUrl: null, gravatarHash: null },
        docId: `page:${pageId}`,
        selectedNodeIds: [site.pages[0].rootNodeId],
        editingNodeId: site.pages[0].rootNodeId,
        pointer: { x: 10, y: 20, breakpointId: 'bp-desktop' },
      })
    })

    const tag = document.querySelector('[data-peer-name-tag]')
    expect(tag?.textContent).toBe('Marge')
    expect(tag?.getAttribute('data-editing')).toBe('true')
    expect(document.querySelector('[data-peer-selection-ring]')).toBeTruthy()
    expect(document.querySelector('[data-peer-pointer]')).toBeTruthy()
  })
})
