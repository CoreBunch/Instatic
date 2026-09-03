/**
 * CollabProvider — the client transport of real-time co-editing.
 *
 * Owns ONE WebSocket to `SITE_SOCKET_PATH` and multiplexes every bound doc
 * over it (frames in @core/collab/protocol):
 *   - bind(docId) returns the live Y.Doc plus a `whenSynced` promise that
 *     resolves after the server's initial sync (docs are NEVER seeded
 *     client-side — the server is the only seeder, so two clients can't
 *     build divergent initial histories; the store gates edits on synced).
 *   - every local transaction (origin ≠ REMOTE_ORIGIN) sends an update frame
 *     immediately — Yjs 'update' events fire synchronously inside the
 *     transaction commit. `send()` still only ENQUEUES, though: bytes sit in
 *     `bufferedAmount` and the browser discards that buffer on unload, so a
 *     large in-flight frame can still be lost by closing the tab. That window
 *     is bounded and flagged via `beforeunload`, not zero.
 *   - an application-level ping/pong bounds how long a black-holed socket can
 *     masquerade as connected, because the write gate refuses edits it cannot
 *     deliver and must not be fooled by `readyState`.
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
  FRAME_PING,
  FRAME_PONG,
  FRAME_RESET,
  FRAME_SYNC,
  PRESENCE_DOC_ID,
  REMOTE_ORIGIN,
  decodeResetReason,
  type ResetReason,
} from '@core/collab'
import { collabSocketUrl } from './socketUrl'

const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000
const PING_INTERVAL_MS = 10_000
/**
 * Bytes queued in the socket's send buffer. Above this the transport is not
 * draining (or is black-holed) and further edits would only join bytes the
 * browser throws away on unload.
 */
const MAX_BACKLOG_BYTES = 512 * 1024

/** y-protocols/sync message types (payload's first varUint). */
const SYNC_STEP_2 = 1

export type CollabStatus = 'connecting' | 'connected' | 'offline'

export interface CollabSocketLike {
  binaryType: string
  readyState: number
  bufferedAmount: number
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

export type CollabResetListener = (docId: string, reason: ResetReason) => void

export interface CollabProvider {
  bind(docId: string): BoundCollabDoc
  unbind(docId: string): void
  awareness: awarenessProtocol.Awareness
  status(): CollabStatus
  /**
   * Whether an edit made right now can actually reach the relay. The write
   * gate and `sendFrame` share this because it is ONE fact.
   */
  canSend(): boolean
  /** Escape the backoff (which reaches 30s) when the user says the network is back. */
  reconnectNow(): void
  onStatus(listener: (status: CollabStatus) => void): () => void
  onReset(listener: CollabResetListener): () => void
  destroy(): void
}

interface BoundEntry {
  doc: Y.Doc
  /**
   * The doc's CRDT lineage, learned from the first inbound frame. `''` means
   * "I hold no server state yet" — the server accepts that for a step1
   * always, and for a write only while its own doc is still empty (the
   * client-created-row flow). See @core/collab/protocol.
   */
  generation: string
  /**
   * Local updates made before the lineage is known. The server refuses a
   * write carrying `''` once its doc has content — and the doc has content
   * as soon as the FIRST such write lands, so a second local change inside
   * the bind round trip (a row created and placed, a seed in two
   * transactions) would be reset as stale. Held here and sent as one update
   * the moment the first inbound frame names the lineage.
   */
  pending: Uint8Array[]
  synced: boolean
  whenSynced: Promise<void>
  resolveSynced: () => void
  updateHandler: (update: Uint8Array, origin: unknown) => void
}

export function createCollabProvider(
  opts: {
    createSocket?: () => CollabSocketLike
    /** Heartbeat period. Overridden only by tests, which cannot wait 10s. */
    pingIntervalMs?: number
  } = {},
): CollabProvider {
  const pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS
  const livenessTimeoutMs = pingIntervalMs * 2.5
  const createSocket =
    opts.createSocket ??
    ((): CollabSocketLike => {
      // Under `vite dev` the socket bypasses the proxy and dials the CMS port
      // directly — see socketUrl.ts for why, and why the hostname is kept.
      const devCmsPort = import.meta.env.DEV
        ? String(import.meta.env.VITE_CMS_DEV_PORT ?? '3001')
        : null
      return new WebSocket(
        collabSocketUrl(window.location, devCmsPort),
      ) as unknown as CollabSocketLike
    })

  const bound = new Map<string, BoundEntry>()
  const statusListeners = new Set<(status: CollabStatus) => void>()
  const resetListeners = new Set<CollabResetListener>()
  let socket: CollabSocketLike | null = null
  let status: CollabStatus = 'connecting'
  let destroyed = false
  let attempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let lastInboundAt = 0

  const presenceDoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(presenceDoc)
  // y-protocols seeds the local state as `{}`, and the connect handler
  // re-announces any non-null state — so without this, every connect
  // broadcast a meaningless empty presence (and its periodic re-announce)
  // that peers must ignore. Stay silent until the editor publishes real
  // presence via usePublishEditorPresence.
  awareness.setLocalState(null)

  function setStatus(next: CollabStatus): void {
    if (status === next) return
    status = next
    for (const listener of statusListeners) listener(next)
  }

  /**
   * `readyState` alone is not enough. On a black-holed path the browser keeps
   * the socket OPEN until the TCP retransmission timeout — minutes — during
   * which every `send()` silently succeeds into a buffer nobody drains. The
   * heartbeat bounds that; `bufferedAmount` catches the slower case where the
   * socket is genuinely open but the bytes are not moving.
   */
  function canSend(): boolean {
    return (
      status === 'connected' &&
      socket !== null &&
      socket.readyState === 1 /* OPEN */ &&
      socket.bufferedAmount <= MAX_BACKLOG_BYTES
    )
  }

  function sendFrame(docId: string, frameType: number, payload: Uint8Array): void {
    // Pings must go out even while the connection is still being judged;
    // everything else respects the gate.
    if (!socket || socket.readyState !== 1 /* OPEN */) return
    if (frameType !== FRAME_PING && !canSend()) return
    socket.send(encodeCollabFrame(docId, bound.get(docId)?.generation ?? '', frameType, payload))
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
      generation: '',
      pending: [],
      synced: false,
      whenSynced,
      resolveSynced,
      updateHandler: (update, origin) => {
        if (origin === REMOTE_ORIGIN) return
        if (entry.generation === '') {
          entry.pending.push(update)
          return
        }
        sendUpdate(docId, update)
      },
    }
    doc.on('update', entry.updateHandler)
    return entry
  }

  function sendUpdate(docId: string, update: Uint8Array): void {
    const encoder = encoding.createEncoder()
    syncProtocol.writeUpdate(encoder, update)
    sendFrame(docId, FRAME_SYNC, encoding.toUint8Array(encoder))
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

    // The inbound timestamp is already taken in onmessage — a pong carries no
    // other meaning.
    if (frame.frameType === FRAME_PONG) return

    if (frame.docId === PRESENCE_DOC_ID && frame.frameType === FRAME_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, frame.payload, REMOTE_ORIGIN)
      return
    }

    const entry = bound.get(frame.docId)
    if (!entry) return

    if (frame.frameType === FRAME_RESET) {
      const reason = decodeResetReason(frame.payload)
      unbind(frame.docId)
      for (const listener of resetListeners) listener(frame.docId, reason)
      return
    }
    // Adopt the server's lineage from the first frame that names one, so every
    // subsequent outbound frame is refusable if this doc is later reseeded —
    // and release the local changes held back until now, as one update.
    if (entry.generation === '' && frame.generation !== '') {
      entry.generation = frame.generation
      if (entry.pending.length > 0) {
        const held = entry.pending
        entry.pending = []
        sendUpdate(frame.docId, held.length === 1 ? held[0]! : Y.mergeUpdates(held))
      }
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
      lastInboundAt = Date.now()
      // Timestamp of the first UNANSWERED ping of the current cycle; a cycle
      // ends when any inbound frame arrives after it.
      let lastPingSentAt = 0
      clearInterval(pingTimer)
      pingTimer = setInterval(() => {
        const now = Date.now()
        // A black hole is a ping that went UNANSWERED — not mere quiet. In a
        // hidden/background webview (a backgrounded browser tab, a
        // minimized window) this interval itself is throttled, so
        // long gaps with no ping sent are normal; judging them as silence
        // used to declare a healthy socket offline the moment the tab
        // resumed, toasting "Still connecting" at whatever the user did
        // next.
        const answered = lastInboundAt >= lastPingSentAt
        if (!answered && now - lastPingSentAt > livenessTimeoutMs) {
          // Publish OFFLINE synchronously: `onclose` is not prompt on a black
          // hole, and the write gate must not keep accepting edits while the
          // toolbar still reads "Draft synced".
          setStatus('offline')
          socket?.close()
          return
        }
        if (answered) lastPingSentAt = now
        sendFrame(PRESENCE_DOC_ID, FRAME_PING, new Uint8Array())
      }, pingIntervalMs)
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
      lastInboundAt = Date.now()
      const { data } = event
      if (data instanceof ArrayBuffer) handleFrame(new Uint8Array(data))
      else if (data instanceof Uint8Array) handleFrame(data)
    }

    // Errors always surface as a close — reconnect is scheduled there.
    socket.onerror = () => {}

    socket.onclose = () => {
      socket = null
      clearInterval(pingTimer)
      pingTimer = undefined
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
    // Settle whenSynced before tearing the doc down — a doc unbound before it
    // ever synced (FRAME_RESET, explicit unbind) would otherwise leave every
    // chained `.then(...)` continuation pending forever.
    if (!entry.synced) {
      entry.synced = true
      entry.resolveSynced()
    }
    entry.doc.off('update', entry.updateHandler)
    entry.doc.destroy()
    bound.delete(docId)
  }

  function beforeUnload(event: BeforeUnloadEvent): void {
    awarenessProtocol.removeAwarenessStates(awareness, [awareness.clientID], 'unload')
    // `send()` only enqueues, and the browser discards `bufferedAmount` on
    // unload. A large paste is one multi-hundred-KB frame, and there is no
    // client-side save path to fall back on — so warn rather than lose it
    // silently. Browsers may ignore this without prior interaction.
    if (socket && socket.bufferedAmount > 0) event.preventDefault()
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
    canSend,
    reconnectNow: () => {
      if (destroyed || status === 'connected' || socket) return
      clearTimeout(reconnectTimer)
      attempts = 0
      connect()
    },
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
      clearInterval(pingTimer)
      if (typeof window !== 'undefined') window.removeEventListener('beforeunload', beforeUnload)
      awareness.off('update', awarenessUpdateHandler)
      awarenessProtocol.removeAwarenessStates(awareness, [awareness.clientID], 'destroy')
      awareness.destroy()
      for (const docId of [...bound.keys()]) unbind(docId)
      const closingSocket = socket
      socket = null
      if (closingSocket) {
        // A socket can finish opening after the editor has already unmounted.
        // Detach every callback before close so that late browser events cannot
        // resurrect the heartbeat or notify listeners on a destroyed provider.
        closingSocket.onopen = null
        closingSocket.onmessage = null
        closingSocket.onclose = null
        closingSocket.onerror = null
        closingSocket.close()
      }
      statusListeners.clear()
      resetListeners.clear()
    },
  }
}
