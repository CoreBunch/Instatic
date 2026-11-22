/**
 * Peer presence — deterministic identity colors, local-state publishing,
 * docId-scoped peer filtering (with TypeBox validation of wire states), and
 * a smoke render of the canvas presence overlay against fake awareness
 * states.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { render, screen, cleanup, act } from '@testing-library/react'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { AdminSessionContext } from '@admin/sessionContext'
import { MAIN_BRANCH_ID } from '@core/branches'
import { encodeCollabDocId, MAIN_SITE_DOC_ID, seedPageDoc, seedSiteDoc, type ResetReason } from '@core/collab'
import type { CmsCurrentUser } from '@core/persistence'
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
import { whenCollabWritable } from '@site/store/slices/site/collabWriteGate'
import type {
  BoundCollabDoc,
  CollabProvider,
  CollabResetListener,
} from '@site/collab/collabProvider'
import { PeerPresenceOverlay } from '@admin/pages/site/canvas/PeerPresenceOverlay'
import { PeerAvatarStack } from '@admin/pages/site/toolbar/PeerAvatarStack'
import '@modules/base/index'

const currentUser: CmsCurrentUser = {
  id: 'u1',
  email: 'editor@example.com',
  displayName: 'Editor',
  status: 'active',
  role: {
    id: 'viewer',
    slug: 'viewer',
    name: 'Viewer',
    description: '',
    isSystem: true,
    capabilities: ['site.read'],
  },
  capabilities: ['site.read'],
  lastLoginAt: null,
  failedLoginCount: 0,
  lockedUntil: null,
  passwordUpdatedAt: null,
  mfaEnabled: false,
  mfaEnabledAt: null,
  mfaRecoveryCodesRemaining: 0,
  stepUpAuthMode: 'required',
  stepUpWindowMinutes: 15,
  avatarMediaId: null,
  avatarUrl: null,
  gravatarHash: '',
  createdAt: '2026-06-10T10:00:00.000Z',
  updatedAt: '2026-06-10T10:00:00.000Z',
}

function WithAdminSession({ children }: { children: ReactNode }) {
  return (
    <AdminSessionContext.Provider value={{ user: currentUser, setUser: () => {} }}>
      {children}
    </AdminSessionContext.Provider>
  )
}

/** Minimal provider stub: real Awareness and server seeds, no transport. */
function fakeProvider(seedDoc?: (docId: string, doc: Y.Doc) => void): CollabProvider & {
  awareness: awarenessProtocol.Awareness
  triggerReset: (docId: string, reason?: ResetReason) => void
} {
  const presenceDoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(presenceDoc)
  const bound = new Map<string, BoundCollabDoc>()
  const resetListeners = new Set<CollabResetListener>()
  return {
    bind: (docId) => {
      let entry = bound.get(docId)
      if (!entry) {
        const doc = new Y.Doc()
        seedDoc?.(docId, doc)
        entry = { doc, synced: true, whenSynced: Promise.resolve() }
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
    triggerReset: (docId, reason = 'rewritten') => {
      for (const listener of resetListeners) listener(docId, reason)
    },
    destroy: () => {
      awareness.destroy()
      presenceDoc.destroy()
    },
  }
}

/** Inject a remote peer's presence into `target` the way the wire would. */
function injectPeerState(target: awarenessProtocol.Awareness, state: unknown): void {
  const peerDoc = new Y.Doc()
  const peer = new awarenessProtocol.Awareness(peerDoc)
  peer.setLocalState(state)
  const update = awarenessProtocol.encodeAwarenessUpdate(peer, [peer.clientID])
  awarenessProtocol.applyAwarenessUpdate(target, update, 'remote')
  peerDoc.destroy()
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
    ).toBe('component:main:vc-1')
    expect(activeEditorDocId({ activeDocument: null, activePageId: 'p1' })).toBe('page:main:p1')
    expect(activeEditorDocId({ activeDocument: null, activePageId: null })).toBeNull()
  })
})

describe('collab reset during inline editing', () => {
  it('ends only the inline session owned by the reset document', () => {
    const store = useEditorStore.getState()
    store.createSite('Reset Site')
    const pageId = useEditorStore.getState().activePageId!
    const page = useEditorStore.getState().site!.pages[0]
    const nodeId = useEditorStore
      .getState()
      .insertNode('base.text', { text: 'hello' }, page.rootNodeId)
    useEditorStore.getState().startInlineEdit(nodeId, 'desktop')
    expect(useEditorStore.getState().activeInlineEdit).not.toBeNull()

    const provider = fakeProvider()
    connectCollabProvider(provider)
    provider.triggerReset('page:main:another-page')
    expect(useEditorStore.getState().activeInlineEdit).not.toBeNull()

    provider.triggerReset(`page:main:${pageId}`)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })
})

describe('usePeerPresences', () => {
  it('returns peers on the same doc, drops other docs and malformed states', async () => {
    const provider = fakeProvider()
    connectCollabProvider(provider)

    render(<PeerList docId="page:main:p1" />, { wrapper: WithAdminSession })

    await act(async () => {
      injectPeerState(provider.awareness, {
        user: { id: 'u2', name: 'Ada', color: peerColor('u2'), avatarUrl: null, gravatarHash: null },
        docId: 'page:main:p1',
        selectedNodeIds: ['n1'],
        editingNodeId: null,
        pointer: null,
        textCaret: null,
      })
      injectPeerState(provider.awareness, {
        user: { id: 'u3', name: 'Grace', color: peerColor('u3'), avatarUrl: null, gravatarHash: null },
        docId: 'page:main:OTHER',
        selectedNodeIds: [],
        editingNodeId: null,
        pointer: null,
        textCaret: null,
      })
      // Malformed wire state — must be dropped by validation, not crash.
      injectPeerState(provider.awareness, { user: { id: 42 }, docId: 'page:main:p1' })
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
    // Scan RULES only — comments may (and do) mention the forbidden pattern.
    const rulesOnly = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rulesOnly).not.toContain('display: none')
  })

  it('shows toolbar and canvas presence only for other accounts', async () => {
    const site = useEditorStore.getState().createSite('Presence Site')
    const [page] = site.pages
    const pageDocId = encodeCollabDocId({ kind: 'page', branchId: MAIN_BRANCH_ID, rowId: page.id })
    const provider = fakeProvider((docId, doc) => {
      if (docId === MAIN_SITE_DOC_ID) seedSiteDoc(doc, site)
      if (docId === pageDocId) seedPageDoc(doc, page)
    })
    connectCollabProvider(provider)
    expect(await whenCollabWritable()).toBe(true)
    expect(useEditorStore.getState().activePageId).toBe(page.id)

    const presence = {
      docId: pageDocId,
      selectedNodeIds: [page.rootNodeId],
      editingNodeId: page.rootNodeId,
      pointer: { x: 10, y: 20, breakpointId: 'bp-desktop' },
      textCaret: null,
    }
    // The toolbar can receive another tab's state before the canvas mounts and publishes ours.
    provider.awareness.setLocalState(null)
    injectPeerState(provider.awareness, {
      ...presence,
      user: {
        id: currentUser.id,
        name: 'Editor',
        color: peerColor(currentUser.id),
        avatarUrl: null,
        gravatarHash: '',
      },
    })

    render(
      <>
        <PeerAvatarStack />
        <PeerPresenceOverlay breakpointId="bp-desktop" iframeElement={null} />
      </>,
      { wrapper: WithAdminSession },
    )

    expect(screen.queryByRole('group', { name: 'Admins editing this site' })).toBeNull()
    expect(document.querySelector('[data-peer-presence-layer]')).toBeNull()

    await act(async () => {
      injectPeerState(provider.awareness, {
        ...presence,
        user: { id: 'u9', name: 'Marge', color: peerColor('u9'), avatarUrl: null, gravatarHash: null },
      })
    })

    const tag = document.querySelector('[data-peer-name-tag]')
    expect(tag?.textContent).toContain('Marge')
    expect(tag?.getAttribute('data-editing')).toBe('true')
    expect(document.querySelector('[data-peer-selection-ring]')).toBeTruthy()
    expect(document.querySelector('[data-peer-pointer]')).toBeTruthy()
    const roster = screen.getByRole('group', { name: 'Admins editing this site' })
    expect(roster.querySelectorAll('[data-peer-avatar]')).toHaveLength(1)
  })
})
