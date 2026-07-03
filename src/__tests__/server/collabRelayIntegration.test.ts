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
 *     reconnect via Yjs state vectors.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
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
import { getDataRow, saveDataRowDraft } from '../../../server/repositories/data'
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
    // must claim the SESSION's real user id or the frame is dropped.
    const { rows: viewerRows } = await stack.harness.db<{ id: string }>`
      select id from users where email = ${viewer.email}
    `
    const viewerUserId = viewerRows[0].id
    viewerClient.awareness.setLocalState({ user: { id: 'someone-else', name: 'Spoof' } })
    viewerClient.awareness.setLocalState({ user: { id: viewerUserId, name: 'Viewer' } })
    await waitFor(() => {
      for (const [, state] of owner.awareness.getStates()) {
        const s = state as { user?: { id?: string; name?: string } }
        if (s.user?.id === viewerUserId) return true
      }
      return false
    })
    // The spoofed frame never relayed.
    for (const [, state] of owner.awareness.getStates()) {
      const s = state as { user?: { id?: string } }
      expect(s.user?.id).not.toBe('someone-else')
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
})
