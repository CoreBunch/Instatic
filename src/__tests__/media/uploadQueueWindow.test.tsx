/**
 * Closing the upload queue window while files are still uploading.
 *
 * The close button worked; an effect immediately undid it. It depended on
 * both `uploadQueue.active` AND the open state, so every close re-ran it and
 * `active && !open` opened the window straight back up. While a transfer was
 * in flight the window could not be made to stay shut.
 *
 * These drive the real hook through the sequence a user produces: an upload
 * starts, they close the window, the page re-renders as progress arrives.
 */

import { describe, expect, it } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { useUploadQueueWindow } from '@admin/pages/media/hooks/useUploadQueueWindow'

function mount(active: boolean) {
  return renderHook(({ active }) => useUploadQueueWindow(active), { initialProps: { active } })
}

describe('the upload queue window', () => {
  it('starts closed when nothing is uploading', () => {
    expect(mount(false).result.current.open).toBe(false)
  })

  it('opens when an upload starts', () => {
    const hook = mount(false)
    hook.rerender({ active: true })
    expect(hook.result.current.open).toBe(true)
  })

  it('is already open when the page mounts mid-upload', () => {
    expect(mount(true).result.current.open).toBe(true)
  })

  it('stays closed after the user closes it mid-upload', () => {
    const hook = mount(false)
    hook.rerender({ active: true })
    act(() => hook.result.current.setOpen(false))
    // Progress keeps re-rendering the page while the transfer runs.
    hook.rerender({ active: true })
    hook.rerender({ active: true })
    expect(hook.result.current.open).toBe(false)
  })

  it('opens again for the NEXT upload', () => {
    const hook = mount(false)
    hook.rerender({ active: true })
    act(() => hook.result.current.setOpen(false))
    hook.rerender({ active: false })
    hook.rerender({ active: true })
    expect(hook.result.current.open).toBe(true)
  })

  it('stays open after a transfer finishes, until the user dismisses it', () => {
    const hook = mount(false)
    hook.rerender({ active: true })
    hook.rerender({ active: false })
    expect(hook.result.current.open).toBe(true)
  })

  it('toggles from the toolbar while idle', () => {
    const hook = mount(false)
    act(() => hook.result.current.setOpen((open) => !open))
    expect(hook.result.current.open).toBe(true)
    act(() => hook.result.current.setOpen((open) => !open))
    expect(hook.result.current.open).toBe(false)
  })
})
