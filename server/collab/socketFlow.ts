/** Serialize incoming work and stop producing replies while Bun buffers a send. */
interface FlowSocket {
  send(frame: Uint8Array): number
  close(code: number, reason: string): void
}

export function createSocketFlow(socket: FlowSocket) {
  let closed = false
  let tail = Promise.resolve()
  let resume: (() => void) | null = null

  function drain(): void {
    const pending = resume
    resume = null
    pending?.()
  }

  return {
    run(task: () => Promise<void>): Promise<void> {
      const next = tail.then(async () => {
        if (!closed) await task()
      })
      // A rejected request must not poison subsequent socket requests.
      tail = next.catch((_err) => {})
      return next
    },
    async send(frame: Uint8Array): Promise<void> {
      if (closed) return
      const result = socket.send(frame)
      if (result === 0) {
        // The frame was dropped: force the provider's state-vector recovery.
        closed = true
        drain()
        socket.close(1011, 'Collaboration delivery failed')
      } else if (result === -1) {
        // Bun already queued this frame. Sending it again would duplicate it.
        await new Promise<void>((resolve) => { resume = resolve })
      }
    },
    drain,
    close(): void {
      closed = true
      drain()
    },
  }
}
