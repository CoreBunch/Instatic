import { afterEach, describe, expect, it } from 'bun:test'
import {
  __resetToastBusForTests,
  pushToast,
  subscribeToasts,
  type Toast,
} from '@ui/components/Toast/toastBus'

afterEach(() => {
  __resetToastBusForTests()
})

describe('toastBus', () => {
  it('sends the current queue snapshot to new subscribers', () => {
    const id = pushToast({
      kind: 'success',
      title: 'Saved',
      durationMs: null,
    })
    let capturedToasts: ReadonlyArray<Toast> = []

    const unsubscribe = subscribeToasts((snapshot) => {
      capturedToasts = snapshot
    })

    expect(capturedToasts.map((toast) => toast.id)).toEqual([id])
    unsubscribe()
  })

  it('resets queued toasts and listeners for test isolation', () => {
    pushToast({
      kind: 'info',
      title: 'Before reset',
      durationMs: null,
    })
    let staleListenerCalls = 0
    subscribeToasts(() => {
      staleListenerCalls += 1
    })

    __resetToastBusForTests()
    pushToast({
      kind: 'info',
      title: 'After reset',
      durationMs: null,
    })
    let capturedToasts: ReadonlyArray<Toast> = []
    const unsubscribe = subscribeToasts((snapshot) => {
      capturedToasts = snapshot
    })

    expect(staleListenerCalls).toBe(1)
    expect(capturedToasts).toHaveLength(1)
    expect(capturedToasts[0]?.title).toBe('After reset')
    unsubscribe()
  })
})
