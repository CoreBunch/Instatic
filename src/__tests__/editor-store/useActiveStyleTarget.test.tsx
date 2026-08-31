/**
 * useActiveStyleTarget — the canvas gestures' style-write channel resolves
 * the SAME editing context as the Properties panel.
 *
 * Regression: the desktop viewport is the BASE context (desktop-first). With
 * `activeBreakpointId === 'desktop'` a canvas gesture (resize handle,
 * free-move drag, gradient gizmo) must write the class's base styles — not a
 * phantom `contextStyles['desktop']` override the panel never shows.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useActiveStyleTarget } from '@site/store/useActiveStyleTarget'

function setupClassSelection() {
  useEditorStore.setState({
    site: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeClassId: null,
    inlineStyleEditing: false,
    activeConditionId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
  const store = useEditorStore.getState()
  const site = store.createSite('Target Test')
  const rootId = site.pages[0].rootNodeId
  const nodeId = useEditorStore.getState().insertNode('base.text', {}, rootId)
  useEditorStore.getState().selectNode(nodeId)
  const cls = useEditorStore.getState().createClass('box')
  useEditorStore.getState().setActiveClass(cls.id)
  return cls.id
}

function writeViaHook(patch: Record<string, string>) {
  const { result } = renderHook(() => useActiveStyleTarget())
  expect(result.current).not.toBeNull()
  result.current!.writeStyles(patch)
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('useActiveStyleTarget context resolution', () => {
  it('the desktop viewport writes BASE class styles, not a desktop override', () => {
    const classId = setupClassSelection()
    useEditorStore.setState({ activeBreakpointId: 'desktop' })

    writeViaHook({ width: '456px' })

    const rule = useEditorStore.getState().site!.styleRules[classId]
    expect(rule.styles.width).toBe('456px')
    expect(rule.contextStyles['desktop']).toBeUndefined()
  })

  it('a non-desktop viewport writes that breakpoint context', () => {
    const classId = setupClassSelection()
    useEditorStore.setState({ activeBreakpointId: 'mobile' })

    writeViaHook({ width: '300px' })

    const rule = useEditorStore.getState().site!.styleRules[classId]
    expect(rule.styles.width).toBeUndefined()
    expect(rule.contextStyles['mobile']?.width).toBe('300px')
  })

  it('inline editing exposes the inline target on the base viewport', () => {
    setupClassSelection()
    useEditorStore.getState().setActiveClass(null)
    useEditorStore.getState().setInlineStyleEditing(true)
    useEditorStore.setState({ activeBreakpointId: 'desktop' })

    const { result } = renderHook(() => useActiveStyleTarget())
    expect(result.current?.kind).toBe('inline')
  })

  it('inline editing on a non-base viewport has NO writable target', () => {
    // Inline styles are base-only: a write here would change every
    // breakpoint, so the hook must report "no unambiguous target".
    setupClassSelection()
    useEditorStore.getState().setActiveClass(null)
    useEditorStore.getState().setInlineStyleEditing(true)
    useEditorStore.setState({ activeBreakpointId: 'tablet' })

    const { result } = renderHook(() => useActiveStyleTarget())
    expect(result.current).toBeNull()
  })
})
