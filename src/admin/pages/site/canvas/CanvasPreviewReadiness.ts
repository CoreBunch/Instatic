/**
 * Tracks asynchronous work that can change a canvas preview after its first
 * React commit. Visible editor frames do not provide this context; the Agent's
 * one-shot evidence frame does, so only that read path waits for data/media
 * lookups before it captures pixels and layout.
 */

import { createContext } from 'react'

export interface CanvasPreviewReadiness {
  track: (task: Promise<unknown>) => void
  waitUntilIdle: (signal: AbortSignal) => Promise<boolean>
  pendingCount: () => number
  revision: () => number
}

export const CanvasPreviewReadinessContext =
  createContext<CanvasPreviewReadiness | null>(null)

export function createCanvasPreviewReadiness(): CanvasPreviewReadiness {
  let pending = 0
  let revision = 0
  const idleListeners = new Set<() => void>()

  const release = () => {
    pending = Math.max(0, pending - 1)
    revision += 1
    if (pending !== 0) return
    for (const listener of idleListeners) listener()
    idleListeners.clear()
  }

  return {
    track(task) {
      pending += 1
      revision += 1
      // Observe both branches so a failed preview request still releases the
      // barrier and never creates an unhandled rejection of our own.
      void task.then(release, release)
    },
    waitUntilIdle(signal) {
      if (pending === 0) return Promise.resolve(true)
      if (signal.aborted) return Promise.resolve(false)

      return new Promise<boolean>((resolve) => {
        let settled = false
        const finish = (idle: boolean) => {
          if (settled) return
          settled = true
          idleListeners.delete(onIdle)
          signal.removeEventListener('abort', onAbort)
          resolve(idle)
        }
        const onIdle = () => finish(true)
        const onAbort = () => finish(false)
        idleListeners.add(onIdle)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    },
    pendingCount: () => pending,
    revision: () => revision,
  }
}
