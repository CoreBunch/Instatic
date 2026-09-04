/**
 * useDocumentSync — external changes remount, own writes do not, and a
 * burst of store changes costs one projection, not one per change.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useDocumentSync, type DocumentSyncSource } from '@site/code-dock/useDocumentSync'
import '@modules/base/index'

afterEach(cleanup)

function state() {
  return useEditorStore.getState()
}

describe('useDocumentSync', () => {
  it('projects once per animation frame under a burst of store changes, and remounts on a real change', async () => {
    state().clearSite()
    const site = state().createSite('Sync')
    const rootId = site.pages[0].rootNodeId
    let reads = 0
    const source: DocumentSyncSource<{ site: typeof site | null }> = {
      select: (s) => ({ site: s.site }),
      equal: (a, b) => a.site === b.site,
      read: (inputs) => {
        reads++
        const page = inputs.site?.pages[0]
        return page ? { docKey: 'doc', text: String(Object.keys(page.nodes).length) } : null
      },
    }
    const revisions: number[] = []
    function Probe() {
      const { revision } = useDocumentSync(source)
      revisions.push(revision)
      return null
    }
    render(<Probe />)
    const readsAfterMount = reads

    // One synchronous burst: fifty inserts, fifty store notifications.
    act(() => {
      for (let i = 0; i < 50; i++) state().insertNode('base.text', { text: String(i) }, rootId)
    })
    expect(reads).toBe(readsAfterMount)
    await waitFor(() => expect(revisions.at(-1)).toBe(1))
    expect(reads).toBe(readsAfterMount + 1)
  })
})
