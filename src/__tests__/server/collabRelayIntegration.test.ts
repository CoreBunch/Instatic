/**
 * Collab end-to-end — a real `Bun.serve` running the relay + socket layer,
 * with real client providers (the same transport the editor uses) over real
 * WebSockets:
 *
 *   - two clients edit different nodes concurrently and CONVERGE,
 *   - the relay persists the blob and the derived row JSON after its
 *     debounce (the publisher path reads exactly what admins see),
 *   - a read-only connection's update frames are ignored,
 *   - an out-of-relay row write triggers the reset protocol,
 *   - a client that missed edits while disconnected catches up on
 *     reconnect via Yjs state vectors,
 *   - one peer cannot erase another peer's presence for everyone,
 *   - `runPublishFlush` drains the persist debounce, so publish bakes the
 *     edit an admin made seconds earlier instead of losing it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import {
  LOCAL_ORIGIN,
  projectPageDoc,
  SITE_SOCKET_PATH,
  treeMap,
} from '@core/collab'
import { pageFromRow } from '@core/data/pageFromRow'
import {
  createCollabProvider,
  type CollabProvider,
  type CollabSocketLike,
} from '@site/collab/collabProvider'
import { createCollabRelay } from '../../../server/collab/relay'
import {
  createCollabSocketLayer,
  handleCollabSocketUpgrade,
} from '../../../server/collab/socket'
import { getCollabDocumentState } from '../../../server/repositories/collabDocuments'
import { runPublishFlush } from '../../../server/publish/publishFlush'
import { getDataRow, saveDataRowDraft } from '../../../server/repositories/data'
import { findUserByEmail } from '../../../server/repositories/users'
import { peerColor } from '@site/collab/awarenessState'
import {
  createCapabilityTestHarness,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
// The update guard classifies prop changes via the module registry.
import '@modules/base/index'

const PERSIST_DEBOUNCE_MS = 25

let cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4_000,
): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface Stack {
  harness: CapabilityTestHarness
  url: string
  cookie: string
  homeId: string
}

async function startStack(): Promise<Stack> {
  const harness = await createCapabilityTestHarness()
  cleanups.push(() => harness.cleanup())
  const cookie = await harness.setupOwner()
  const relay = createCollabRelay(harness.db, { persistDebounceMs: PERSIST_DEBOUNCE_MS })
  cleanups.push(() => relay.destroy())
  const socketLayer = createCollabSocketLayer(relay)

  const server = Bun.serve({
    port: 0,
    fetch: async (req, srv) => {
      if (new URL(req.url).pathname === SITE_SOCKET_PATH) {
        const rejection = await handleCollabSocketUpgrade(req, harness.db, srv)
        if (rejection === null) return undefined
        return rejection
      }
      return new Response('not found', { status: 404 })
    },
    websocket: socketLayer.handlers,
  })
  socketLayer.setPublisher(server)
  cleanups.push(() => server.stop(true))

  const { rows } = await harness.db<{ id: string }>`
    select id from data_rows where table_id = ${'pages'}
  `
  return {
    harness,
    url: `ws://localhost:${server.port}${SITE_SOCKET_PATH}`,
    cookie,
    homeId: rows[0].id,
  }
}

/** Real editor transport over a real WebSocket, authenticated by cookie. */
function connectClient(
  stack: Stack,
  cookie = stack.cookie,
): CollabProvider & { lastSocket: () => WebSocket | null } {
  let lastSocket: WebSocket | null = null
  const provider = createCollabProvider({
    createSocket: () => {
      // Bun's WebSocket client supports custom handshake headers.
      lastSocket = new WebSocket(stack.url, { headers: { cookie } })
      return lastSocket as unknown as CollabSocketLike
    },
  })
  cleanups.push(() => provider.destroy())
  return Object.assign(provider, { lastSocket: () => lastSocket })
}

function setNodeLabel(doc: Y.Doc, nodeId: string, label: string): void {
  doc.transact(() => {
    const nodes = treeMap(doc).get('nodes') as Y.Map<unknown>
    const node = nodes.get(nodeId) as Y.Map<unknown>
    node.set('label', label)
  }, LOCAL_ORIGIN)
}

function nodeLabel(doc: Y.Doc, nodeId: string): unknown {
  const nodes = treeMap(doc).get('nodes') as Y.Map<unknown> | undefined
  const node = nodes?.get(nodeId) as Y.Map<unknown> | undefined
  return node?.get('label')
}

function insertChildNode(doc: Y.Doc, nodeId: string, moduleId: string): void {
  doc.transact(() => {
    const tree = treeMap(doc)
    const nodes = tree.get('nodes') as Y.Map<unknown>
    const rootId = tree.get('rootNodeId') as string
    const node = new Y.Map<unknown>()
    node.set('moduleId', moduleId)
    node.set('props', new Y.Map())
    node.set('breakpointOverrides', new Y.Map())
    node.set('children', new Y.Array())
    node.set('classIds', [])
    nodes.set(nodeId, node)
    const rootChildren = (nodes.get(rootId) as Y.Map<unknown>).get('children') as Y.Array<string>
    rootChildren.push([nodeId])
  }, LOCAL_ORIGIN)
}

describe('collab relay integration (real server, real sockets)', () => {
  it('two clients edit concurrently, converge, and the relay persists blob + derived JSON', async () => {
    const stack = await startStack()
    const docId = `page:${stack.homeId}`

    const clientA = connectClient(stack)
    const clientB = connectClient(stack)
    const boundA = clientA.bind(docId)
    const boundB = clientB.bind(docId)
    await boundA.whenSynced
    await boundB.whenSynced

    const rootId = treeMap(boundA.doc).get('rootNodeId') as string
    expect(treeMap(boundB.doc).get('rootNodeId')).toBe(rootId)

    // Concurrent edits on DIFFERENT nodes: A relabels the root, B inserts a
    // sibling — merged, not last-writer-wins.
    setNodeLabel(boundA.doc, rootId, 'Renamed by A')
    insertChildNode(boundB.doc, 'node-from-b', 'base.text')

    await waitFor(
      () =>
        nodeLabel(boundB.doc, rootId) === 'Renamed by A' &&
        (treeMap(boundA.doc).get('nodes') as Y.Map<unknown>).has('node-from-b'),
    )

    // The relay persists the blob AND the derived row JSON after its debounce.
    await waitFor(async () => {
      const stored = await getCollabDocumentState(stack.harness.db, docId)
      if (!stored) return false
      const restored = new Y.Doc()
      Y.applyUpdate(restored, stored)
      return nodeLabel(restored, rootId) === 'Renamed by A'
    })
    await waitFor(async () => {
      const row = await getDataRow(stack.harness.db, stack.homeId)
      if (!row) return false
      const page = pageFromRow(row)
      return page.nodes[rootId]?.label === 'Renamed by A' && page.nodes['node-from-b'] !== undefined
    })
  })

  it('drops update frames from a read-only connection', async () => {
    const stack = await startStack()
    const docId = `page:${stack.homeId}`

    const viewer = await stack.harness.createRoleUser({
      name: 'Read Only',
      slug: 'collab-viewer',
      capabilities: ['site.read'],
    })
    const writer = connectClient(stack)
    const readOnly = connectClient(stack, viewer.cookie)
    const boundWriter = writer.bind(docId)
    const boundReadOnly = readOnly.bind(docId)
    await boundWriter.whenSynced
    await boundReadOnly.whenSynced

    const rootId = treeMap(boundReadOnly.doc).get('rootNodeId') as string
    // The read-only client's local doc changes, but the server ignores the
    // update frame — no other peer ever sees it.
    setNodeLabel(boundReadOnly.doc, rootId, 'Sneaky viewer edit')

    // Happened-after marker on a DIFFERENT key — writing the same key would
    // make the assertion depend on Yjs' concurrent-set clientID tiebreak
    // (random per run), not on the server's drop. Once the marker lands on
    // the viewer, the server has processed both frames.
    boundWriter.doc.transact(() => {
      const nodes = treeMap(boundWriter.doc).get('nodes') as Y.Map<unknown>
      ;(nodes.get(rootId) as Y.Map<unknown>).set('marker', 'writer-was-here')
    }, LOCAL_ORIGIN)
    await waitFor(() => {
      const nodes = treeMap(boundReadOnly.doc).get('nodes') as Y.Map<unknown>
      return (nodes.get(rootId) as Y.Map<unknown>).get('marker') === 'writer-was-here'
    })

    // The sneaky edit never reached the WRITER — the server dropped it.
    expect(nodeLabel(boundWriter.doc, rootId)).not.toBe('Sneaky viewer edit')
  })

  it('enforces per-category capabilities on partial writers and relays read-only presence', async () => {
    const stack = await startStack()
    const docId = `page:${stack.homeId}`

    const contentUser = await stack.harness.createRoleUser({
      name: 'Copy Editor',
      slug: 'collab-content-only',
      capabilities: ['site.read', 'site.content.edit'],
    })
    const viewer = await stack.harness.createRoleUser({
      name: 'Viewer',
      slug: 'collab-presence-viewer',
      capabilities: ['site.read'],
    })

    const owner = connectClient(stack)
    const contentClient = connectClient(stack, contentUser.cookie)
    const viewerClient = connectClient(stack, viewer.cookie)
    const boundOwner = owner.bind(docId)
    const boundContent = contentClient.bind(docId)
    viewerClient.bind(docId)
    await boundOwner.whenSynced
    await boundContent.whenSynced

    // Owner (full writer) adds a text node the content editor may write to.
    insertChildNode(boundOwner.doc, 'text-node', 'base.text')
    await waitFor(() =>
      (treeMap(boundContent.doc).get('nodes') as Y.Map<unknown>).has('text-node'),
    )

    // ALLOWED: a content-category prop change from the content-only editor.
    boundContent.doc.transact(() => {
      const nodes = treeMap(boundContent.doc).get('nodes') as Y.Map<unknown>
      const props = (nodes.get('text-node') as Y.Map<unknown>).get('props') as Y.Map<unknown>
      props.set('text', 'copy edited')
    }, LOCAL_ORIGIN)
    await waitFor(() => {
      const nodes = treeMap(boundOwner.doc).get('nodes') as Y.Map<unknown>
      const props = (nodes.get('text-node') as Y.Map<unknown>).get('props') as Y.Map<unknown>
      return props.get('text') === 'copy edited'
    })

    // REJECTED: a structural change (node insertion) from the same editor —
    // the server refuses the update and resets the sender's doc.
    const resets: string[] = []
    contentClient.onReset((id) => resets.push(id))
    insertChildNode(boundContent.doc, 'forbidden-node', 'base.container')
    await waitFor(() => resets.includes(docId))
    // Reset was sent INSTEAD of applying — the authoritative doc never saw it.
    expect((treeMap(boundOwner.doc).get('nodes') as Y.Map<unknown>).has('forbidden-node')).toBe(false)

    // Read-only presence: a viewer's awareness state reaches other peers
    // (presence is not a doc write). Identity is server-verified — the state
    // must claim the SESSION's FULL identity (id + name + avatar + gravatar)
    // or the frame is dropped, so a peer can't paint another admin's name.
    const viewerUser = await findUserByEmail(stack.harness.db, viewer.email)
    const viewerUserId = viewerUser!.id
    const realIdentity = {
      id: viewerUserId,
      name: viewerUser!.displayName,
      color: peerColor(viewerUserId),
      avatarUrl: viewerUser!.avatarUrl,
      gravatarHash: viewerUser!.gravatarHash,
    }
    // A frame keeping the real id but faking the name is still a spoof.
    viewerClient.awareness.setLocalState({ user: { ...realIdentity, name: 'Owner Impersonator' } })
    viewerClient.awareness.setLocalState({ user: { id: 'someone-else', name: 'Spoof' } })
    viewerClient.awareness.setLocalState({ user: realIdentity })
    await waitFor(() => {
      for (const [, state] of owner.awareness.getStates()) {
        const s = state as { user?: { id?: string; name?: string } }
        if (s.user?.id === viewerUserId) return true
      }
      return false
    })
    // Neither spoofed frame relayed: no foreign id, no impersonated name.
    for (const [, state] of owner.awareness.getStates()) {
      const s = state as { user?: { id?: string; name?: string } }
      expect(s.user?.id).not.toBe('someone-else')
      if (s.user?.id === viewerUserId) expect(s.user?.name).toBe(viewerUser!.displayName)
    }
  })

  it('resets a doc when the row is written outside the relay', async () => {
    const stack = await startStack()
    const docId = `page:${stack.homeId}`

    const client = connectClient(stack)
    const bound = client.bind(docId)
    await bound.whenSynced

    const resets: string[] = []
    client.onReset((id) => resets.push(id))

    // Out-of-relay write (imports, plugins, HTTP save): mutate the stored
    // JSON directly — the repository notifies, the relay drops the doc and
    // broadcasts FRAME_RESET.
    const row = await getDataRow(stack.harness.db, stack.homeId)
    await saveDataRowDraft(stack.harness.db, stack.homeId, {
      cells: { ...row!.cells, title: 'Rewritten outside the relay' },
      slug: row!.slug,
    })

    await waitFor(() => resets.includes(docId))

    // Rebinding gets a FRESH server seed carrying the out-of-relay write.
    const rebound = client.bind(docId)
    await rebound.whenSynced
    const projected = projectPageDoc(rebound.doc, stack.homeId)
    expect(projected.title).toBe('Rewritten outside the relay')
  })

  it('a reconnecting client catches up on edits it missed while offline', async () => {
    const stack = await startStack()
    const docId = `page:${stack.homeId}`

    const clientA = connectClient(stack)
    const clientB = connectClient(stack)
    const boundA = clientA.bind(docId)
    const boundB = clientB.bind(docId)
    await boundA.whenSynced
    await boundB.whenSynced
    const rootId = treeMap(boundA.doc).get('rootNodeId') as string

    // Drop A's socket; B keeps editing while A is offline.
    clientA.lastSocket()?.close()
    setNodeLabel(boundB.doc, rootId, 'Edited while A was away')

    // A's provider reconnects on its own (1s backoff) and step1's state
    // vector pulls exactly the missed delta into the SAME doc.
    await waitFor(() => nodeLabel(boundA.doc, rootId) === 'Edited while A was away', 8_000)
  }, 12_000)

  it('a peer cannot erase another peer\'s presence for everyone', async () => {
    const stack = await startStack()
    const docId = `page:${stack.homeId}`

    const identityOf = async (email: string) => {
      const user = (await findUserByEmail(stack.harness.db, email))!
      return {
        id: user.id,
        name: user.displayName,
        color: peerColor(user.id),
        avatarUrl: user.avatarUrl,
        gravatarHash: user.gravatarHash,
      }
    }

    const evictorUser = await stack.harness.createRoleUser({
      name: 'Evictor',
      slug: 'collab-presence-evictor',
      capabilities: ['site.read'],
    })
    const victimUser = await stack.harness.createRoleUser({
      name: 'Victim',
      slug: 'collab-presence-victim',
      capabilities: ['site.read'],
    })

    // A third peer is the judge: presence is a broadcast, so what matters is
    // what OTHER admins still see — not what the evictor sees in its own tab.
    const watcher = connectClient(stack)
    const evictor = connectClient(stack, evictorUser.cookie)
    const victim = connectClient(stack, victimUser.cookie)
    watcher.bind(docId)
    evictor.bind(docId)
    victim.bind(docId)

    const evictorIdentity = await identityOf(evictorUser.email)
    const victimIdentity = await identityOf(victimUser.email)

    victim.awareness.setLocalState({ user: victimIdentity })

    const watcherSees = (userId: string): boolean => {
      for (const [, state] of watcher.awareness.getStates()) {
        const s = state as { user?: { id?: string } }
        if (s.user?.id === userId) return true
      }
      return false
    }
    await waitFor(() => watcherSees(victimIdentity.id))

    // The evictor broadcasts a removal for a clientID it does NOT own. This is
    // exactly what y-protocols emits on its own when it believes a peer timed
    // out (`checkOutdatedAwarenessStates`) — routine chatter, not an attack —
    // but honouring it would let any peer evict any other peer for EVERYONE.
    // The relay refuses: presence is cleared only by its owner, or by that
    // owner's disconnect.
    awarenessProtocol.removeAwarenessStates(
      evictor.awareness,
      [victim.awareness.clientID],
      'evict',
    )

    // Order the wire: this legit frame is sent AFTER the removal, so once the
    // watcher sees the evictor, the relay has already decided the removal's
    // fate. Without this the assertion below could pass simply by racing ahead
    // of a clear that was about to land.
    evictor.awareness.setLocalState({ user: evictorIdentity })
    await waitFor(() => watcherSees(evictorIdentity.id))

    // The victim never re-announced — if the relay had honoured the foreign
    // clear, they would be gone from the watcher's roster by now.
    expect(watcherSees(victimIdentity.id)).toBe(true)
  })

  it('runPublishFlush persists edits still inside the relay debounce window', async () => {
    // The publisher reads ROWS, not Y docs. Every publish path awaits
    // `runPublishFlush()` first (see publishFlush.ts) so an edit made seconds
    // before the click is baked instead of lost to the debounce. Without this
    // seam the published HTML silently trails the editor.
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    const cookie = await harness.setupOwner()
    // A debounce long enough that nothing persists on its own during the test:
    // any row change we observe can ONLY have come from the explicit flush.
    const relay = createCollabRelay(harness.db, { persistDebounceMs: 60_000 })
    cleanups.push(() => relay.destroy())
    const socketLayer = createCollabSocketLayer(relay)

    const server = Bun.serve({
      port: 0,
      fetch: async (req, srv) => {
        if (new URL(req.url).pathname === SITE_SOCKET_PATH) {
          const rejection = await handleCollabSocketUpgrade(req, harness.db, srv)
          if (rejection === null) return undefined
          return rejection
        }
        return new Response('not found', { status: 404 })
      },
      websocket: socketLayer.handlers,
    })
    socketLayer.setPublisher(server)
    cleanups.push(() => server.stop(true))

    const { rows } = await harness.db<{ id: string }>`
      select id from data_rows where table_id = ${'pages'}
    `
    const homeId = rows[0].id
    const stack: Stack = {
      harness,
      url: `ws://localhost:${server.port}${SITE_SOCKET_PATH}`,
      cookie,
      homeId,
    }

    const client = connectClient(stack)
    const bound = client.bind(`page:${homeId}`)
    await bound.whenSynced
    const rootId = treeMap(bound.doc).get('rootNodeId') as string

    // A second client is the honest way to observe the SERVER's doc: once the
    // edit reaches this peer, the relay has definitely applied it. Asserting on
    // the editing client's own doc would pass before the frame ever left it.
    const observer = connectClient(stack)
    const boundObserver = observer.bind(`page:${homeId}`)
    await boundObserver.whenSynced

    setNodeLabel(bound.doc, rootId, 'Edited seconds before publish')
    await waitFor(() => nodeLabel(boundObserver.doc, rootId) === 'Edited seconds before publish')

    const labelInRow = async (): Promise<unknown> => {
      const row = await getDataRow(harness.db, homeId)
      return pageFromRow(row!).nodes[rootId]?.label
    }

    // The relay holds the edit in memory, but the ROW the publisher reads does
    // not — the debounce has not elapsed.
    expect(await labelInRow()).not.toBe('Edited seconds before publish')

    // This is what every publish path does before it reads rows.
    await runPublishFlush()

    expect(await labelInRow()).toBe('Edited seconds before publish')
  })
})
