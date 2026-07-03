/**
 * CollabProvider — the client transport of real-time co-editing.
 *
 * Owns ONE WebSocket to `SITE_SOCKET_PATH` and multiplexes every bound doc
 * over it (frames in @core/collab/protocol):
 *   - bind(docId) returns the live Y.Doc plus a `whenSynced` promise that
 *     resolves after the server's initial sync (docs are NEVER seeded
 *     client-side — the server is the only seeder, so two clients can't
 *     build divergent initial histories; the store gates edits on synced).
 *   - every local transaction (origin ≠ REMOTE_ORIGIN) sends an update
 *     frame immediately — Yjs 'update' events fire synchronously inside the
 *     transaction commit, so there is no flush window to lose on unload.
 *   - reconnect uses exponential backoff; on every (re)connect each bound
 *     doc re-runs syncStep1, and Yjs state vectors make the catch-up delta
 *     exact — the transport is self-healing by construction.
 *   - FRAME_RESET (server dropped a doc whose JSON was rewritten
 *     out-of-relay) unbinds the doc and notifies `onReset`; the binding
 *     layer rebinds and the doc reseeds server-side.
 *   - awareness (cursors/selections) rides the same socket under
 *     PRESENCE_DOC_ID via y-protocols/awareness.
 *
 * The socket factory is injectable for tests; production uses the browser
 * WebSocket against the same origin (the Vite dev proxy forwards upgrades).
 */
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import {
  decodeCollabFrame,
  encodeCollabFrame,
  FRAME_AWARENESS,
  FRAME_RESET,
  FRAME_SYNC,
  PRESENCE_DOC_ID,
  REMOTE_ORIGIN,
  SITE_SOCKET_PATH,
} from '@core/collab'

const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000

/** y-protocols/sync message types (payload's first varUint). */
const SYNC_STEP_2 = 1

export type CollabStatus = 'connecting' | 'connected' | 'offline'

export interface CollabSocketLike {
  binaryType: string
  readyState: number
  send(data: Uint8Array): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

export interface BoundCollabDoc {
  doc: Y.Doc
  synced: boolean
  whenSynced: Promise<void>
}

export interface CollabProvider {
  bind(docId: string): BoundCollabDoc
  unbind(docId: string): void
  awareness: awarenessProtocol.Awareness
  status(): CollabStatus
  onStatus(listener: (status: CollabStatus) => void): () => void
  onReset(listener: (docId: string) => void): () => void
  destroy(): void
}

interface BoundEntry {
  doc: Y.Doc
  synced: boolean
  whenSynced: Promise<void>
  resolveSynced: () => void
  updateHandler: (update: Uint8Array, origin: unknown) => void
}

export function createCollabProvider(
  opts: { createSocket?: () => CollabSocketLike } = {},
): CollabProvider {
  const createSocket =
    opts.createSocket ??
    ((): CollabSocketLike => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      return new WebSocket(
        `${protocol}://${window.location.host}${SITE_SOCKET_PATH}`,
      ) as unknown as CollabSocketLike
    })

  const bound = new Map<string, BoundEntry>()
  const statusListeners = new Set<(status: CollabStatus) => void>()
  const resetListeners = new Set<(docId: string) => void>()
  let socket: CollabSocketLike | null = null
  let status: CollabStatus = 'connecting'
  let destroyed = false
  let attempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  const presenceDoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(presenceDoc)

  function setStatus(next: CollabStatus): void {
    if (status === next) return
    status = next
    for (const listener of statusListeners) listener(next)
  }

  function sendFrame(docId: string, frameType: number, payload: Uint8Array): void {
    if (!socket || socket.readyState !== 1 /* OPEN */) return
    socket.send(encodeCollabFrame(docId, frameType, payload))
  }

  function sendSyncStep1(docId: string, doc: Y.Doc): void {
    const encoder = encoding.createEncoder()
    syncProtocol.writeSyncStep1(encoder, doc)
    sendFrame(docId, FRAME_SYNC, encoding.toUint8Array(encoder))
  }

  function attachDoc(docId: string, doc: Y.Doc): BoundEntry {
    let resolveSynced!: () => void
    const whenSynced = new Promise<void>((resolve) => {
      resolveSynced = resolve
    })
    const entry: BoundEntry = {
      doc,
      synced: false,
      whenSynced,
      resolveSynced,
      updateHandler: (update, origin) => {
        if (origin === REMOTE_ORIGIN) return
        const encoder = encoding.createEncoder()
        syncProtocol.writeUpdate(encoder, update)
        sendFrame(docId, FRAME_SYNC, encoding.toUint8Array(encoder))
      },
    }
    doc.on('update', entry.updateHandler)
    return entry
  }

  const awarenessUpdateHandler = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE_ORIGIN) return
    const changed = [...added, ...updated, ...removed]
    if (changed.length === 0) return
    sendFrame(
      PRESENCE_DOC_ID,
      FRAME_AWARENESS,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
    )
  }
  awareness.on('update', awarenessUpdateHandler)

  function handleFrame(data: Uint8Array): void {
    const frame = decodeCollabFrame(data)

    if (frame.docId === PRESENCE_DOC_ID && frame.frameType === FRAME_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, frame.payload, REMOTE_ORIGIN)
      return
    }

    const entry = bound.get(frame.docId)
    if (!entry) return

    if (frame.frameType === FRAME_RESET) {
      unbind(frame.docId)
      for (const listener of resetListeners) listener(frame.docId)
      return
    }
    if (frame.frameType !== FRAME_SYNC) return

    const messageType = decoding.readVarUint(decoding.createDecoder(frame.payload))
    const decoder = decoding.createDecoder(frame.payload)
    const encoder = encoding.createEncoder()
    syncProtocol.readSyncMessage(decoder, encoder, entry.doc, REMOTE_ORIGIN)
    if (encoding.length(encoder) > 0) {
      sendFrame(frame.docId, FRAME_SYNC, encoding.toUint8Array(encoder))
    }
    if (messageType === SYNC_STEP_2 && !entry.synced) {
      entry.synced = true
      entry.resolveSynced()
    }
  }

  function connect(): void {
    if (destroyed) return
    setStatus('connecting')
    socket = createSocket()
    socket.binaryType = 'arraybuffer'

    socket.onopen = () => {
      attempts = 0
      setStatus('connected')
      for (const [docId, entry] of bound) sendSyncStep1(docId, entry.doc)
      // Re-announce local presence after a reconnect.
      const localState = awareness.getLocalState()
      if (localState !== null) {
        sendFrame(
          PRESENCE_DOC_ID,
          FRAME_AWARENESS,
          awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
        )
      }
    }

    socket.onmessage = (event) => {
      const { data } = event
      if (data instanceof ArrayBuffer) handleFrame(new Uint8Array(data))
      else if (data instanceof Uint8Array) handleFrame(data)
    }

    // Errors always surface as a close — reconnect is scheduled there.
    socket.onerror = () => {}

    socket.onclose = () => {
      socket = null
      if (destroyed) return
      setStatus('offline')
      const delay =
        Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempts) +
        Math.random() * 500
      attempts += 1
      reconnectTimer = setTimeout(connect, delay)
    }
  }

  function unbind(docId: string): void {
    const entry = bound.get(docId)
    if (!entry) return
    entry.doc.off('update', entry.updateHandler)
    entry.doc.destroy()
    bound.delete(docId)
  }

  function beforeUnload(): void {
    awarenessProtocol.removeAwarenessStates(awareness, [awareness.clientID], 'unload')
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', beforeUnload)
  }

  connect()

  return {
    bind: (docId) => {
      const existing = bound.get(docId)
      if (existing) return existing
      const entry = attachDoc(docId, new Y.Doc())
      bound.set(docId, entry)
      sendSyncStep1(docId, entry.doc)
      return entry
    },
    unbind,
    awareness,
    status: () => status,
    onStatus: (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    onReset: (listener) => {
      resetListeners.add(listener)
      return () => resetListeners.delete(listener)
    },
    destroy: () => {
      destroyed = true
      clearTimeout(reconnectTimer)
      if (typeof window !== 'undefined') window.removeEventListener('beforeunload', beforeUnload)
      awareness.off('update', awarenessUpdateHandler)
      awarenessProtocol.removeAwarenessStates(awareness, [awareness.clientID], 'destroy')
      awareness.destroy()
      for (const docId of [...bound.keys()]) unbind(docId)
      socket?.close()
      socket = null
    },
  }
}
