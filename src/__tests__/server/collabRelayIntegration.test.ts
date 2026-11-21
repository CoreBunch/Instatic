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
import type { DbClient } from '../../../server/db/client'
import { requireCapability } from '../../../server/auth/authz'
import { userDisplayLabel } from '@core/users/displayName'
import { afterEach, describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import {
  decodeCollabFrame,
  encodeCollabFrame,
  FRAME_PING,
  FRAME_PONG,
  FRAME_SYNC,
  PRESENCE_DOC_ID,
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
import { createCollabRelay, type CollabRelay } from '../../../server/collab/relay'
import { MAIN_SCOPE } from '../../../server/branches/scope'
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
  relay: CollabRelay
  url: string
  cookie: string
  homeId: string
}

async function startStack({ wrapRelay = (relay) => relay, wrapDb = (db) => db }: {
  wrapRelay?: (relay: CollabRelay) => CollabRelay
  wrapDb?: (db: DbClient) => DbClient
} = {}): Promise<Stack> {
  const harness = await createCapabilityTestHarness()
  cleanups.push(() => harness.cleanup())
  const cookie = await harness.setupOwner()
  const relay = createCollabRelay(harness.db, { persistDebounceMs: PERSIST_DEBOUNCE_MS })
  cleanups.push(() => relay.destroy())
  const socketLayer = createCollabSocketLayer(wrapRelay(relay), wrapDb(harness.db))

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
  cleanups.push(() => server.stop(true))

  const { rows } = await harness.db<{ id: string }>`
    select id from data_rows where table_id = ${'pages'}
  `
  return {
    harness,
    relay,
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
    const docId = `page:main:${stack.homeId}`

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
      Y.applyUpdate(restored, stored.state)
      return nodeLabel(restored, rootId) === 'Renamed by A'
    })
    await waitFor(async () => {
      const row = await getDataRow(stack.harness.db, MAIN_SCOPE, stack.homeId)
      if (!row) return false
      const page = pageFromRow(row)
      return page.nodes[rootId]?.label === 'Renamed by A' && page.nodes['node-from-b'] !== undefined
    })
  })

  it('keeps the cells the doc does not own when it persists the derived row', async () => {
    const stack = await startStack()
    const docId = `page:main:${stack.homeId}`
    // SEO lives on the row, never in the doc. Seeded as a collab-internal
    // write so the roster's already-loaded doc is not reset under the client;
    // what is under test is what the relay's own persist keeps on the row.
    const seeded = (await getDataRow(stack.harness.db, MAIN_SCOPE, stack.homeId))!
    await saveDataRowDraft(
      stack.harness.db,
      MAIN_SCOPE,
      stack.homeId,
      { cells: { ...seeded.cells, seoTitle: 'Kept title', seoDescription: 'Kept description' }, slug: seeded.slug },
      null,
      null,
      { collabInternal: true },
    )

    const client = connectClient(stack)
    const bound = client.bind(docId)
    await bound.whenSynced
    const rootId = treeMap(bound.doc).get('rootNodeId') as string
    setNodeLabel(bound.doc, rootId, 'Edited in the doc')

    await waitFor(async () => {
      const row = await getDataRow(stack.harness.db, MAIN_SCOPE, stack.homeId)
      return row !== null && pageFromRow(row).nodes[rootId]?.label === 'Edited in the doc'
    })
    const row = (await getDataRow(stack.harness.db, MAIN_SCOPE, stack.homeId))!
    expect(row.cells.seoTitle).toBe('Kept title')
    expect(row.cells.seoDescription).toBe('Kept description')
  })

  it('refuses a read-only edit AND resets the viewer so its own screen reverts', async () => {
    const stack = await startStack()
    const docId = `page:main:${stack.homeId}`

    const viewer = await stack.harness.createRoleUser({
      name: 'Read Only',
      slug: 'collab-viewer',
      capabilities: ['site.read'],
    })
    const writer = connectClient(stack)
    const readOnly = connectClient(stack, viewer.cookie)
    const resets: string[] = []
    readOnly.onReset((id) => resets.push(id))
    const boundWriter = writer.bind(docId)
    const boundReadOnly = readOnly.bind(docId)
    await boundWriter.whenSynced
    await boundReadOnly.whenSynced

    const rootId = treeMap(boundReadOnly.doc).get('rootNodeId') as string
    // The read-only client mutates its local doc (a not-yet-disabled UI
    // affordance, a plugin, the console). The server refuses the update — no
    // other peer ever sees it.
    setNodeLabel(boundReadOnly.doc, rootId, 'Sneaky viewer edit')

    // Happened-after marker on a DIFFERENT key — writing the same key would
    // make the assertion depend on Yjs' concurrent-set clientID tiebreak
    // (random per run), not on the server's refusal. Once the marker lands on
    // the viewer, the server has processed both frames.
    boundWriter.doc.transact(() => {
      const nodes = treeMap(boundWriter.doc).get('nodes') as Y.Map<unknown>
      ;(nodes.get(rootId) as Y.Map<unknown>).set('marker', 'writer-was-here')
    }, LOCAL_ORIGIN)
    await waitFor(() => {
      const nodes = treeMap(boundReadOnly.doc).get('nodes') as Y.Map<unknown>
      return (nodes.get(rootId) as Y.Map<unknown>).get('marker') === 'writer-was-here'
    })

    // The sneaky edit never reached the WRITER — the guard refused it.
    expect(nodeLabel(boundWriter.doc, rootId)).not.toBe('Sneaky viewer edit')

    // …and the refusal RESETS the viewer, so its own optimistic edit reverts
    // instead of stranding it in a divergent doc that still reports "synced".
    // A read-only connection used to be dropped silently at a `canWrite` gate
    // with no reset, leaving exactly that permanent local divergence.
    await waitFor(() => resets.includes(docId))
    const rebound = readOnly.bind(docId)
    await rebound.whenSynced
    expect(nodeLabel(rebound.doc, rootId)).not.toBe('Sneaky viewer edit')
  })

  it('enforces per-category capabilities on partial writers and relays read-only presence', async () => {
    const stack = await startStack()
    const docId = `page:main:${stack.homeId}`

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
      name: userDisplayLabel(viewerUser!),
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
      if (s.user?.id === viewerUserId) expect(s.user?.name).toBe(userDisplayLabel(viewerUser!))
    }
  })

  it('resets a doc when the row is written outside the relay', async () => {
    const stack = await startStack()
    const docId = `page:main:${stack.homeId}`

    const client = connectClient(stack)
    const bound = client.bind(docId)
    await bound.whenSynced

    const resets: string[] = []
    client.onReset((id) => resets.push(id))

    // Out-of-relay write (imports, plugins, HTTP save): mutate the stored
    // JSON directly — the repository notifies, the relay drops the doc and
    // broadcasts FRAME_RESET.
    const row = await getDataRow(stack.harness.db, MAIN_SCOPE, stack.homeId)
    await saveDataRowDraft(stack.harness.db, MAIN_SCOPE, stack.homeId, {
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
    const docId = `page:main:${stack.homeId}`

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
    const docId = `page:main:${stack.homeId}`

    const identityOf = async (email: string) => {
      const user = (await findUserByEmail(stack.harness.db, email))!
      return {
        id: user.id,
        name: userDisplayLabel(user),
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
    const socketLayer = createCollabSocketLayer(relay, harness.db)

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
    const bound = client.bind(`page:main:${homeId}`)
    await bound.whenSynced
    const rootId = treeMap(bound.doc).get('rootNodeId') as string

    // A second client is the honest way to observe the SERVER's doc: once the
    // edit reaches this peer, the relay has definitely applied it. Asserting on
    // the editing client's own doc would pass before the frame ever left it.
    const observer = connectClient(stack)
    const boundObserver = observer.bind(`page:main:${homeId}`)
    await boundObserver.whenSynced

    setNodeLabel(bound.doc, rootId, 'Edited seconds before publish')
    await waitFor(() => nodeLabel(boundObserver.doc, rootId) === 'Edited seconds before publish')

    const labelInRow = async (): Promise<unknown> => {
      const row = await getDataRow(harness.db, MAIN_SCOPE, homeId)
      return pageFromRow(row!).nodes[rootId]?.label
    }

    // The relay holds the edit in memory, but the ROW the publisher reads does
    // not — the debounce has not elapsed.
    expect(await labelInRow()).not.toBe('Edited seconds before publish')

    // This is what every publish path does before it reads rows.
    await runPublishFlush()

    expect(await labelInRow()).toBe('Edited seconds before publish')
  })

  // ── CRDT lineage ──────────────────────────────────────────────────────────

  it('refuses a stale lineage instead of merging a dead generation', async () => {
    const stack = await startStack()
    const docId = `page:main:${stack.homeId}`

    const client = connectClient(stack)
    const bound = client.bind(docId)
    await bound.whenSynced
    const rootId = treeMap(bound.doc).get('rootNodeId') as string
    setNodeLabel(bound.doc, rootId, 'Before the reset')
    await waitFor(async () => {
      const row = await getDataRow(stack.harness.db, MAIN_SCOPE, stack.homeId)
      return Boolean(row && pageFromRow(row).nodes[rootId]?.label === 'Before the reset')
    })

    const resets: string[] = []
    client.onReset((id, reason) => resets.push(`${id}:${reason}`))

    // Reset the doc the way an out-of-relay write does. The client is still
    // bound and still holds generation N, whose structs sit at the very
    // coordinates the reseeded generation N+1 now occupies.
    await stack.relay.resetDocs([docId])

    // The client's own frames must not be merged into the new lineage.
    await waitFor(() => resets.length > 0)
    expect(resets[0]).toBe(`${docId}:rewritten`)

    // And the authoritative doc must project the reseeded content — no ghost
    // nodes carried over from the dead lineage.
    const { doc: authoritative } = await stack.relay.openDoc(docId)
    const nodes = treeMap(authoritative).get('nodes') as Y.Map<unknown>
    expect(nodes.has(rootId)).toBe(true)
  })

  it('a frame stamped with a dead generation is answered with a reset, not applied', async () => {
    const stack = await startStack()
    const docId = `page:main:${stack.homeId}`
    const client = connectClient(stack)
    const bound = client.bind(docId)
    await bound.whenSynced

    const { generation: live } = await stack.relay.openDoc(docId)
    const rootId = treeMap(bound.doc).get('rootNodeId') as string
    const before = nodeLabel(bound.doc, rootId)

    const socket = client.lastSocket()!
    const encoder = encoding.createEncoder()
    const forged = new Y.Doc()
    Y.applyUpdate(forged, Y.encodeStateAsUpdate(bound.doc))
    setNodeLabel(forged, rootId, 'From a dead lineage')
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(forged))
    socket.send(
      encodeCollabFrame(docId, `${live}-dead`, FRAME_SYNC, encoding.toUint8Array(encoder)),
    )

    await new Promise((resolve) => setTimeout(resolve, 150))
    const { doc: authoritative } = await stack.relay.openDoc(docId)
    expect(nodeLabel(authoritative, rootId)).toBe(before)
  })

  it('answers a ping on a read-only connection without touching the relay', async () => {
    const stack = await startStack()
    const viewer = await stack.harness.createRoleUser({
      name: 'Ping Viewer',
      slug: 'collab-ping-viewer',
      capabilities: ['site.read'],
    })
    const client = connectClient(stack, viewer.cookie)
    // Give the socket a moment to open before probing liveness.
    await waitFor(() => client.status() === 'connected')

    const socket = client.lastSocket()!
    const pongs: number[] = []
    socket.addEventListener('message', (event: MessageEvent) => {
      const data = new Uint8Array(event.data as ArrayBuffer)
      pongs.push(decodeCollabFrame(data).frameType)
    })
    socket.send(encodeCollabFrame(PRESENCE_DOC_ID, '', FRAME_PING, new Uint8Array()))

    await waitFor(() => pongs.includes(FRAME_PONG))
    expect(client.status()).toBe('connected')
  })

  // The mirror of "a reconnecting client catches up on edits it missed": that
  // test proves server → client. This proves client → server, which is the
  // direction that was silently dropping work.
  it('recovers edits authored while the socket was down, on reconnect', async () => {
    const stack = await startStack()
    const docId = `page:main:${stack.homeId}`

    const client = connectClient(stack)
    const bound = client.bind(docId)
    await bound.whenSynced
    const rootId = treeMap(bound.doc).get('rootNodeId') as string

    // Kill the transport, then edit. The frame is dropped on the floor —
    // `sendFrame` cannot reach a closed socket.
    client.lastSocket()!.close()
    await waitFor(() => client.status() !== 'connected')
    setNodeLabel(bound.doc, rootId, 'Written while offline')

    // The relay has NOT seen it.
    const { doc: beforeReconnect } = await stack.relay.openDoc(docId)
    expect(nodeLabel(beforeReconnect, rootId)).not.toBe('Written while offline')

    // Reconnect. The server asks what this client holds, and the client's
    // existing readSyncMessage answers with exactly the missing delta.
    client.reconnectNow()
    await waitFor(async () => {
      const { doc: authoritative } = await stack.relay.openDoc(docId)
      return nodeLabel(authoritative, rootId) === 'Written while offline'
    })

    // And it reaches storage, not just memory.
    await waitFor(async () => {
      const row = await getDataRow(stack.harness.db, MAIN_SCOPE, stack.homeId)
      return Boolean(row && pageFromRow(row).nodes[rootId]?.label === 'Written while offline')
    })
  })
})

/** Ping is queued behind the edit on this same socket, so no timing guess is needed. */
async function settleSocket(socket: WebSocket): Promise<void> {
  let settled = socket.readyState === WebSocket.CLOSED
  const onClose = () => { settled = true }
  const onMessage = (event: MessageEvent) => {
    if (decodeCollabFrame(new Uint8Array(event.data as ArrayBuffer)).frameType === FRAME_PONG) settled = true
  }
  socket.addEventListener('close', onClose)
  socket.addEventListener('message', onMessage)
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(encodeCollabFrame(PRESENCE_DOC_ID, '', FRAME_PING, new Uint8Array()))
  }
  try { await waitFor(() => settled) } finally {
    socket.removeEventListener('close', onClose)
    socket.removeEventListener('message', onMessage)
  }
}

describe('collab authorization changes on an existing socket', () => {
  for (const writer of ['full', 'partial'] as const) {
    for (const change of ['suspension', 'role removal', 'write removal', 'logout', 'expiry', 'deletion', 'role reassignment'] as const) {
      it(`blocks persisted ${writer}-writer edits after ${change}`, async () => {
        const stack = await startStack()
        const editor = await stack.harness.createRoleUser({
          name: 'Revocable Editor', slug: 'revocable-editor',
          capabilities: writer === 'full'
            ? ['site.read', 'site.structure.edit', 'site.content.edit', 'site.style.edit']
            : ['site.read', 'site.structure.edit'],
        })
        const user = (await findUserByEmail(stack.harness.db, editor.email))!
        const docId = `page:main:${stack.homeId}`
        const client = connectClient(stack, editor.cookie)
        const bound = client.bind(docId)
        await bound.whenSynced
        const rootId = treeMap(bound.doc).get('rootNodeId') as string
        setNodeLabel(bound.doc, rootId, 'Authorized edit')
        await settleSocket(client.lastSocket()!)
        await stack.relay.flushAll()
        expect(pageFromRow((await getDataRow(stack.harness.db, MAIN_SCOPE, stack.homeId))!).nodes[rootId]?.label).toBe('Authorized edit')

        if (change === 'suspension' || change === 'role reassignment') {
          expect((await stack.harness.cms(`/admin/api/cms/users/${user.id}`, {
            method: 'PATCH', cookie: stack.cookie,
            json: change === 'suspension' ? { status: 'suspended' } : { roleId: 'member' },
          })).status).toBe(200)
        } else if (change === 'deletion') {
          expect((await stack.harness.cms(`/admin/api/cms/users/${user.id}`, {
            method: 'DELETE', cookie: stack.cookie,
          })).status).toBe(200)
        } else if (change === 'logout') {
          expect((await stack.harness.cms('/admin/api/cms/logout', {
            method: 'POST', cookie: editor.cookie,
          })).status).toBe(200)
        } else if (change === 'expiry') {
          await stack.harness.db`update sessions set expires_at = ${new Date(0)} where user_id = ${user.id}`
        } else {
          expect((await stack.harness.cms(`/admin/api/cms/roles/${editor.roleId}`, {
            method: 'PATCH', cookie: stack.cookie,
            json: { capabilities: change === 'write removal' ? ['site.read'] : [] },
          })).status).toBe(200)
        }
        const deniedStatus = ['role removal', 'write removal', 'role reassignment'].includes(change) ? 403 : 401
        const request = new Request(`http://localhost${SITE_SOCKET_PATH}`)
        request.headers.set('cookie', editor.cookie)
        const denied = await requireCapability(request, stack.harness.db, 'site.structure.edit')
        expect(denied).toBeInstanceOf(Response)
        expect((denied as Response).status).toBe(deniedStatus)
        if (change !== 'write removal') {
          const handshake = await handleCollabSocketUpgrade(request, stack.harness.db, {
            upgrade: () => { throw new Error('Revoked session must not upgrade') },
          })
          expect(handshake?.status).toBe(deniedStatus)
        }

        const originalSocket = client.lastSocket()!
        expect(originalSocket.readyState).toBe(WebSocket.OPEN)
        setNodeLabel(bound.doc, rootId, 'Unauthorized edit')
        await settleSocket(originalSocket)
        await stack.relay.flushAll()
        const row = (await getDataRow(stack.harness.db, MAIN_SCOPE, stack.homeId))!
        expect(pageFromRow(row).nodes[rootId]?.label).toBe('Authorized edit')
        expect(nodeLabel((await stack.relay.openDoc(docId)).doc, rootId)).toBe('Authorized edit')
      })
    }
  }

  for (const change of ['suspension', 'role removal', 'logout'] as const) {
    it(`does not broadcast new document content after ${change} to an idle peer`, async () => {
      const stack = await startStack()
      const editor = await stack.harness.createRoleUser({
        name: 'Revocable Reader', slug: 'revocable-reader', capabilities: ['site.read'],
      })
      const user = (await findUserByEmail(stack.harness.db, editor.email))!
      const docId = `page:main:${stack.homeId}`
      const owner = connectClient(stack)
      const reader = connectClient(stack, editor.cookie)
      const ownerDoc = owner.bind(docId)
      const readerDoc = reader.bind(docId)
      await ownerDoc.whenSynced
      await readerDoc.whenSynced
      const rootId = treeMap(ownerDoc.doc).get('rootNodeId') as string
      const response = change === 'suspension'
        ? await stack.harness.cms(`/admin/api/cms/users/${user.id}`, {
          method: 'PATCH', cookie: stack.cookie, json: { status: 'suspended' },
        })
        : change === 'role removal'
          ? await stack.harness.cms(`/admin/api/cms/roles/${editor.roleId}`, {
            method: 'PATCH', cookie: stack.cookie, json: { capabilities: [] },
          })
          : await stack.harness.cms('/admin/api/cms/logout', { method: 'POST', cookie: editor.cookie })
      expect(response.status).toBe(200)
      const socket = reader.lastSocket()!
      let received = false
      let closed = false
      socket.addEventListener('close', () => { closed = true })
      readerDoc.doc.on('update', () => { received = nodeLabel(readerDoc.doc, rootId) === 'Private update after suspension' })
      setNodeLabel(ownerDoc.doc, rootId, 'Private update after suspension')
      await waitFor(() => received || closed)
      expect(received).toBe(false)
      expect(closed).toBe(true)
    })
  }

  it('rechecks permissions after asynchronous document loading', async () => {
    let hold = false
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const stack = await startStack({ wrapRelay: (relay) => ({
      ...relay,
      openDoc: async (docId) => {
        const bound = await relay.openDoc(docId)
        if (hold) {
          entered.resolve()
          await resume.promise
        }
        return bound
      },
    }) })
    const editor = await stack.harness.createRoleUser({
      name: 'Delayed Editor', slug: 'delayed-editor',
      capabilities: ['site.read', 'site.structure.edit', 'site.content.edit', 'site.style.edit'],
    })
    const user = (await findUserByEmail(stack.harness.db, editor.email))!
    const docId = `page:main:${stack.homeId}`
    const client = connectClient(stack, editor.cookie)
    const bound = client.bind(docId)
    await bound.whenSynced
    await settleSocket(client.lastSocket()!)
    const rootId = treeMap(bound.doc).get('rootNodeId') as string
    const previous = nodeLabel(bound.doc, rootId)
    hold = true
    setNodeLabel(bound.doc, rootId, 'Edit delayed across suspension')
    try {
      await entered.promise
      expect((await stack.harness.cms(`/admin/api/cms/users/${user.id}`, {
        method: 'PATCH', cookie: stack.cookie, json: { status: 'suspended' },
      })).status).toBe(200)
    } finally { resume.resolve() }
    await settleSocket(client.lastSocket()!)
    expect(nodeLabel((await stack.relay.openDoc(docId)).doc, rootId)).toBe(previous)
    await stack.relay.flushAll()
    expect(pageFromRow((await getDataRow(stack.harness.db, MAIN_SCOPE, stack.homeId))!).nodes[rootId]?.label).toBe(previous)
  })

  it('uses current category permissions for recovery step2 and keeps allowed edits working', async () => {
    const stack = await startStack()
    const editor = await stack.harness.createRoleUser({
      name: 'Reduced Editor', slug: 'reduced-editor',
      capabilities: ['site.read', 'site.structure.edit', 'site.content.edit', 'site.style.edit'],
    })
    const docId = `page:main:${stack.homeId}`
    const client = connectClient(stack, editor.cookie)
    const bound = client.bind(docId)
    await bound.whenSynced
    insertChildNode(bound.doc, 'copy-node', 'base.text')
    await settleSocket(client.lastSocket()!)
    expect((await stack.harness.cms(`/admin/api/cms/roles/${editor.roleId}`, {
      method: 'PATCH', cookie: stack.cookie, json: { capabilities: ['site.read', 'site.content.edit'] },
    })).status).toBe(200)
    const socket = client.lastSocket()!
    const authoritative = await stack.relay.openDoc(docId)
    const fork = new Y.Doc()
    cleanups.push(() => fork.destroy())
    Y.applyUpdate(fork, Y.encodeStateAsUpdate(bound.doc))
    insertChildNode(fork, 'forbidden-recovery-node', 'base.text')
    const encoder = encoding.createEncoder()
    syncProtocol.writeSyncStep2(encoder, fork)
    socket.send(encodeCollabFrame(docId, authoritative.generation, FRAME_SYNC, encoding.toUint8Array(encoder)))
    await settleSocket(socket)
    expect((treeMap(authoritative.doc).get('nodes') as Y.Map<unknown>).has('forbidden-recovery-node')).toBe(false)
    const rebound = client.bind(docId)
    await rebound.whenSynced
    const props = ((treeMap(rebound.doc).get('nodes') as Y.Map<unknown>).get('copy-node') as Y.Map<unknown>).get('props') as Y.Map<unknown>
    props.set('text', 'Still allowed')
    await settleSocket(socket)
    await stack.relay.flushAll()
    const page = pageFromRow((await getDataRow(stack.harness.db, MAIN_SCOPE, stack.homeId))!)
    expect(page.nodes['copy-node']?.props['text']).toBe('Still allowed')
    expect(page.nodes['forbidden-recovery-node']).toBeUndefined()
    expect(socket.readyState).toBe(WebSocket.OPEN)
  })

  it('fails closed when session validation is unavailable', async () => {
    let unavailable = false
    const stack = await startStack({ wrapDb: (db) => new Proxy(db, {
      get(target, property) {
        if (property === 'unsafe' && unavailable) {
          return () => { throw new Error('Simulated authorization database outage') }
        }
        return Reflect.get(target, property)
      },
    }) })
    const docId = `page:main:${stack.homeId}`
    const client = connectClient(stack)
    const bound = client.bind(docId)
    await bound.whenSynced
    await settleSocket(client.lastSocket()!)
    const rootId = treeMap(bound.doc).get('rootNodeId') as string
    const previous = nodeLabel(bound.doc, rootId)
    const socket = client.lastSocket()!
    let closeCode: number | undefined
    socket.addEventListener('close', (event) => { closeCode = event.code })
    unavailable = true
    setNodeLabel(bound.doc, rootId, 'Edit during authorization outage')
    await settleSocket(socket)
    expect(closeCode).toBe(1011)
    expect(nodeLabel((await stack.relay.openDoc(docId)).doc, rootId)).toBe(previous)
    await stack.relay.flushAll()
    expect(pageFromRow((await getDataRow(stack.harness.db, MAIN_SCOPE, stack.homeId))!).nodes[rootId]?.label).toBe(previous)
  })

})


describe('collab socket lifecycle review', () => {
  it('releases a document acquired after its socket has already closed', async () => {
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let retained = false
    let releases = 0
    let prematureReleases = 0
    const stack = await startStack({ wrapRelay: (relay) => ({
      ...relay,
      retain: async (docId) => {
        entered.resolve()
        await resume.promise
        const bound = await relay.retain(docId)
        retained = true
        return bound
      },
      release: (docId) => {
        if (!retained) prematureReleases++
        releases++
        relay.release(docId)
      },
    }) })
    const client = connectClient(stack)
    client.bind(`page:main:${stack.homeId}`)
    try {
      await entered.promise
      const socket = client.lastSocket()!
      client.destroy()
      await waitFor(() => socket.readyState === WebSocket.CLOSED)
    } finally { resume.resolve() }
    await waitFor(() => retained && releases > 0)
    expect(prematureReleases).toBe(0)
    expect(releases).toBe(1)
  })

  it('delivers an 8 MiB stored document through session-authorized packets', async () => {
    const stack = await startStack()
    const viewer = await stack.harness.createRoleUser({
      name: 'Large Document Reader', slug: 'large-doc-reader', capabilities: ['site.read'],
    })
    const docId = `page:main:${stack.homeId}`
    const { doc } = await stack.relay.openDoc(docId)
    const rootId = treeMap(doc).get('rootNodeId') as string
    const label = 'x'.repeat(8 * 1024 * 1024)
    setNodeLabel(doc, rootId, label)
    await stack.relay.flushAll()
    const client = connectClient(stack, viewer.cookie)
    const bound = client.bind(docId)
    await bound.whenSynced
    expect(nodeLabel(bound.doc, rootId) === label).toBe(true)
    expect(client.lastSocket()?.readyState).toBe(WebSocket.OPEN)
  }, 10_000)
})
