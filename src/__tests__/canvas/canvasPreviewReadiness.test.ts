import { describe, expect, it } from 'bun:test'
import { createCanvasPreviewReadiness } from '@site/canvas/CanvasPreviewReadiness'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

describe('canvas preview readiness', () => {
  it('waits for every tracked task and advances its revision', async () => {
    const readiness = createCanvasPreviewReadiness()
    const first = deferred()
    const second = deferred()
    readiness.track(first.promise)
    readiness.track(second.promise)

    const controller = new AbortController()
    let settled = false
    const idle = readiness.waitUntilIdle(controller.signal).then((value) => {
      settled = true
      return value
    })

    first.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(readiness.pendingCount()).toBe(1)

    second.resolve()
    expect(await idle).toBe(true)
    expect(readiness.pendingCount()).toBe(0)
    expect(readiness.revision()).toBe(4)
  })

  it('releases rejected tasks without creating a poisoned barrier', async () => {
    const readiness = createCanvasPreviewReadiness()
    const task = deferred()
    readiness.track(task.promise)
    const idle = readiness.waitUntilIdle(new AbortController().signal)

    task.reject(new Error('preview failed'))
    expect(await idle).toBe(true)
    expect(readiness.pendingCount()).toBe(0)
  })

  it('returns false when the waiter is aborted', async () => {
    const readiness = createCanvasPreviewReadiness()
    const task = deferred()
    readiness.track(task.promise)
    const controller = new AbortController()
    const idle = readiness.waitUntilIdle(controller.signal)

    controller.abort()
    expect(await idle).toBe(false)
    task.resolve()
    await Promise.resolve()
    expect(readiness.pendingCount()).toBe(0)
  })
})
