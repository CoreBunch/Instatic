import { afterEach, describe, expect, it } from 'bun:test'
import {
  clearCollabBlockNotice,
  collabBlockToast,
  collabResetToast,
  resetTargetsActiveDocument,
} from '@site/store/slices/site/collabNotices'
import {
  __resetToastBusForTests,
  subscribeToasts,
  type Toast,
} from '@ui/components/Toast/toastBus'

afterEach(() => {
  clearCollabBlockNotice()
  __resetToastBusForTests()
})

describe('collab notices', () => {
  it('shows one blocked-edit toast per outage and re-arms after recovery', () => {
    let toasts: ReadonlyArray<Toast> = []
    const unsubscribe = subscribeToasts((next) => {
      toasts = next
    })

    expect(collabBlockToast('offline')).toBe(true)
    expect(collabBlockToast('offline')).toBe(false)
    expect(collabBlockToast('connecting')).toBe(false)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({
      kind: 'error',
      title: 'Change not applied',
    })

    clearCollabBlockNotice()
    expect(collabBlockToast('syncing')).toBe(true)
    expect(toasts).toHaveLength(2)
    unsubscribe()
  })

  it('keeps routine reseeds silent but reports discarded local work', () => {
    let toasts: ReadonlyArray<Toast> = []
    const unsubscribe = subscribeToasts((next) => {
      toasts = next
    })

    collabResetToast('rewritten')
    expect(toasts).toHaveLength(0)
    collabResetToast('stale')
    collabResetToast('refused')
    collabResetToast('oversize')

    expect(toasts.map((toast) => toast.title)).toEqual([
      'A change was reverted',
      'A change was reverted',
      'A change was reverted',
    ])
    unsubscribe()
  })

  it('matches resets only to the active page or visual component', () => {
    expect(
      resetTargetsActiveDocument('page:page-1', { kind: 'page', pageId: 'page-1' }, null),
    ).toBe(true)
    expect(
      resetTargetsActiveDocument('page:page-1', { kind: 'visualComponent', vcId: 'vc-1' }, 'page-1'),
    ).toBe(true)
    expect(
      resetTargetsActiveDocument(
        'component:vc-1',
        { kind: 'visualComponent', vcId: 'vc-1' },
        'page-1',
      ),
    ).toBe(true)
    expect(
      resetTargetsActiveDocument('component:vc-2', { kind: 'page', pageId: 'page-1' }, 'page-1'),
    ).toBe(false)
  })
})
