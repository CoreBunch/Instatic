/**
 * previewInlineStyles — the inline-target sibling of the class preview channel.
 *
 * Typing in the inspector with an inline style target previews on the canvas
 * through this session field (NodeRenderer overlays it on the node's stored
 * bag). Pins the no-op guard and the scoped clear, so a stale clear from one
 * row cannot wipe another node's live preview.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'

beforeEach(() => {
  useEditorStore.setState({ previewInlineStyles: null })
})

describe('previewInlineStyles', () => {
  it('stores the patch for the node and clears it', () => {
    const store = useEditorStore.getState()
    store.setPreviewInlineStyles({ nodeId: 'n1', styles: { paddingTop: '12px' } })
    expect(useEditorStore.getState().previewInlineStyles).toEqual({
      nodeId: 'n1',
      styles: { paddingTop: '12px' },
    })

    store.clearPreviewInlineStyles()
    expect(useEditorStore.getState().previewInlineStyles).toBeNull()
  })

  it('an equal patch is a no-op — no store churn per repeated keystroke', () => {
    const store = useEditorStore.getState()
    store.setPreviewInlineStyles({ nodeId: 'n1', styles: { paddingTop: '12px' } })
    const first = useEditorStore.getState().previewInlineStyles
    store.setPreviewInlineStyles({ nodeId: 'n1', styles: { paddingTop: '12px' } })
    expect(useEditorStore.getState().previewInlineStyles).toBe(first)
  })

  it('a clear scoped to another node leaves the live preview alone', () => {
    const store = useEditorStore.getState()
    store.setPreviewInlineStyles({ nodeId: 'n1', styles: { width: '100px' } })
    store.clearPreviewInlineStyles('n2')
    expect(useEditorStore.getState().previewInlineStyles?.nodeId).toBe('n1')
    store.clearPreviewInlineStyles('n1')
    expect(useEditorStore.getState().previewInlineStyles).toBeNull()
  })
})
