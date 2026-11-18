/** Serialize incoming work and stop producing replies while Bun buffers a send. */
import { collabFramePackets } from '@core/collab'

const MAX_QUEUED_BROADCAST_BYTES = 16 * 1024 * 1024

interface FlowSocket {
  send(frame: Uint8Array): number
  close(code: number, reason: string): void
}

export function createSocketFlow(socket: FlowSocket, maySend?: () => Promise<boolean>) {
  let queuedBroadcastBytes = 0
  let closed = false
  let tail = Promise.resolve()
  let resume: (() => void) | null = null

  function drain(): void {
    const pending = resume
    resume = null
    pending?.()
  }

  const flow = {
    run(task: () => Promise<void>): Promise<void> {
      const next = tail.then(async () => {
        if (!closed) await task()
      })
      // A rejected request must not poison subsequent socket requests.
      tail = next.catch((_err) => {})
      return next
    },
    enqueue(frame: Uint8Array): Promise<void> {
      if (closed) return Promise.resolve()
      if (queuedBroadcastBytes + frame.byteLength > MAX_QUEUED_BROADCAST_BYTES) {
        closed = true
        drain()
        socket.close(1011, 'Collaboration backlog exceeded')
        return Promise.resolve()
      }
      queuedBroadcastBytes += frame.byteLength
      return flow.run(() => flow.send(frame)).finally(() => { queuedBroadcastBytes -= frame.byteLength })
    },
    async send(frame: Uint8Array): Promise<void> {
      for (const packet of collabFramePackets(frame)) {
        if (closed) return
        // Check each packet, including after a backpressure wait. A revocation
        // must stop the rest of a large snapshot, not just the next frame.
        if (maySend && !(await maySend())) return
        if (closed) return
        const result = socket.send(packet)
        if (result === 0) {
          // The frame was dropped: force the provider's state-vector recovery.
          closed = true
          drain()
          socket.close(1011, 'Collaboration delivery failed')
        } else if (result === -1) {
          // Bun already queued this frame. Sending it again would duplicate it.
          await new Promise<void>((resolve) => { resume = resolve })
        }
      }
    },
    drain,
    close(): void {
      closed = true
      drain()
    },
  }
  return flow
}
