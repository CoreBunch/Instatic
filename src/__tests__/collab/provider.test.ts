/**
 * CollabProvider transport behavior against an in-memory fake socket:
 * step1 on bind, immediate update frames on local transactions, remote
 * update application under REMOTE_ORIGIN, synced gating on step2, and the
 * reset flow. The real wire runs in collabRelayIntegration.test.ts.
 */
import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import {
  decodeCollabFrame,
  encodeCollabFrame,
  FRAME_PING,
  FRAME_RESET,
  FRAME_SYNC,
  LOCAL_ORIGIN,
} from '@core/collab'
import {
  createCollabProvider,
  type CollabSocketLike,
} from '@site/collab/collabProvider'

class FakeSocket implements CollabSocketLike {
  binaryType = 'arraybuffer'
  readyState = 1
  bufferedAmount = 0
  sent: Uint8Array[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send(data: Uint8Array): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
  open(): void {
    this.onopen?.()
  }
  emit(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) })
  }
}

function lastSyncMessageType(socket: FakeSocket, docId: string): number | null {
  for (let i = socket.sent.length - 1; i >= 0; i--) {
    const frame = decodeCollabFrame(socket.sent[i])
    if (frame.docId === docId && frame.frameType === FRAME_SYNC) {
      return decoding.readVarUint(decoding.createDecoder(frame.payload))
    }
  }
  return null
}

describe('collab provider', () => {
  it('sends syncStep1 for a bound doc on connect and marks it synced on step2', async () => {
    const socket = new FakeSocket()
    const provider = createCollabProvider({ createSocket: () => socket })
    socket.open()
    const binding = provider.bind('page:p1')
    expect(lastSyncMessageType(socket, 'page:p1')).toBe(0) // step1
    expect(binding.synced).toBe(false)

    // Server replies with step2 (its full state against our vector).
    const serverDoc = new Y.Doc()
    serverDoc.getMap('tree').set('rootNodeId', 'root')
    const encoder = encoding.createEncoder()
    syncProtocol.writeSyncStep2(encoder, serverDoc, Y.encodeStateVector(new Y.Doc()))
    socket.emit(encodeCollabFrame('page:p1', 'gen-1', FRAME_SYNC, encoding.toUint8Array(encoder)))

    await binding.whenSynced
    expect(binding.synced).toBe(true)
    expect(binding.doc.getMap('tree').get('rootNodeId')).toBe('root')
    provider.destroy()
  })

  it('sends an update frame immediately on a local transaction; remote-applied updates do not echo', () => {
    const socket = new FakeSocket()
    const provider = createCollabProvider({ createSocket: () => socket })
    socket.open()
    const { doc } = provider.bind('page:p1')
    const sentBefore = socket.sent.length

    doc.transact(() => {
      doc.getMap('tree').set('rootNodeId', 'root')
    }, LOCAL_ORIGIN)
    expect(socket.sent.length).toBe(sentBefore + 1)
    expect(lastSyncMessageType(socket, 'page:p1')).toBe(2) // update

    // A remote update applied by the provider must NOT be re-sent.
    const remote = new Y.Doc()
    remote.getMap('meta').set('title', 'From remote')
    const encoder = encoding.createEncoder()
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(remote))
    const countBeforeRemote = socket.sent.length
    socket.emit(encodeCollabFrame('page:p1', 'gen-1', FRAME_SYNC, encoding.toUint8Array(encoder)))
    expect(doc.getMap('meta').get('title')).toBe('From remote')
    expect(socket.sent.length).toBe(countBeforeRemote)
    provider.destroy()
  })

  it('a reset frame unbinds the doc and notifies listeners', () => {
    const socket = new FakeSocket()
    const provider = createCollabProvider({ createSocket: () => socket })
    socket.open()
    provider.bind('page:p1')
    const resets: string[] = []
    provider.onReset((docId) => resets.push(docId))

    socket.emit(encodeCollabFrame('page:p1', 'gen-1', FRAME_RESET, new Uint8Array()))
    expect(resets).toEqual(['page:p1'])
    // A rebind gets a FRESH doc (the old one was destroyed).
    const rebound = provider.bind('page:p1')
    expect(rebound.synced).toBe(false)
    provider.destroy()
  })

  it('settles whenSynced when a never-synced doc is unbound (no hanging awaiters)', async () => {
    const socket = new FakeSocket()
    const provider = createCollabProvider({ createSocket: () => socket })
    socket.open()
    const binding = provider.bind('page:p1') // bound but never sent step2

    let settled = false
    void binding.whenSynced.then(() => {
      settled = true
    })
    // Reset (or any unbind) before the first sync must resolve the promise,
    // not leave every chained continuation pending forever.
    socket.emit(encodeCollabFrame('page:p1', 'gen-1', FRAME_RESET, new Uint8Array()))
    await binding.whenSynced // resolves instead of hanging the test
    await Promise.resolve()
    expect(settled).toBe(true)
    provider.destroy()
  })

  // ── Liveness ──────────────────────────────────────────────────────────────
  // `readyState` cannot distinguish a live socket from a black-holed one, and
  // the write gate refuses edits it cannot deliver — so "connected" has to
  // mean "answered a ping recently", not "the browser has not noticed yet".

  it('pings on an interval and goes offline when the socket stops answering', async () => {
    const socket = new FakeSocket()
    const provider = createCollabProvider({ createSocket: () => socket, pingIntervalMs: 20 })
    const seen: string[] = []
    provider.onStatus((status) => seen.push(status))
    socket.open()
    expect(provider.canSend()).toBe(true)

    // A ping goes out on the interval...
    await Bun.sleep(35)
    const pings = socket.sent.filter((f) => decodeCollabFrame(f).frameType === FRAME_PING)
    expect(pings.length).toBeGreaterThan(0)

    // ...and with no inbound traffic at all, the provider stops claiming to be
    // connected rather than waiting for a close that may never come.
    await Bun.sleep(80)
    expect(provider.status()).toBe('offline')
    expect(provider.canSend()).toBe(false)
    expect(seen).toContain('offline')
    provider.destroy()
  })

  it('refuses to send while the socket backlog is not draining', () => {
    const socket = new FakeSocket()
    const provider = createCollabProvider({ createSocket: () => socket, pingIntervalMs: 60_000 })
    socket.open()
    expect(provider.canSend()).toBe(true)

    // Open, but the bytes are not moving — an edit now would only join a
    // buffer the browser discards on unload.
    socket.bufferedAmount = 1024 * 1024
    expect(provider.canSend()).toBe(false)
    provider.destroy()
  })

  it('reconnectNow escapes the backoff and is a no-op while connected', () => {
    let created = 0
    const socket = new FakeSocket()
    const provider = createCollabProvider({
      createSocket: () => {
        created += 1
        return socket
      },
    })
    socket.open()
    provider.reconnectNow()
    expect(created).toBe(1) // already connected — nothing to do

    socket.readyState = 3
    socket.onclose?.()
    provider.reconnectNow()
    expect(created).toBe(2)
    provider.destroy()
  })
})
