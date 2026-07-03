/**
 * Breakpoint override mutation tests — setBreakpointOverride, clearBreakpointOverride
 *
 * These were at 0% coverage. They are critical before J5 (canvas) ships because:
 * - The canvas breakpoint switcher calls setBreakpointOverride on prop changes
 * - The publisher calls resolveProps() which merges these overrides
 */

import { describe, it, expect } from 'bun:test'
import { create } from 'mutative'
import {
  setBreakpointOverride,
  clearBreakpointOverride,
  createNode,
  insertNode,
} from '@core/page-tree'
import { resolveProps } from '@core/page-tree'
import { makePage } from '../fixtures'

// ---------------------------------------------------------------------------
// setBreakpointOverride
// ---------------------------------------------------------------------------

describe('setBreakpointOverride', () => {
  function makeTestPage() {
    const page = makePage()
    const node = createNode('base.text', { color: '#000', fontSize: 32 })
    insertNode(page, node, page.rootNodeId)
    return { page, nodeId: node.id }
  }

  it('adds a breakpoint override for a single prop', () => {
    const { page, nodeId } = makeTestPage()
    setBreakpointOverride(page, nodeId, 'mobile', { fontSize: 18 })
    expect(page.nodes[nodeId].breakpointOverrides['mobile']).toEqual({ fontSize: 18 })
  })

  it('shallow-merges with existing overrides for the same breakpoint', () => {
    const { page, nodeId } = makeTestPage()
    setBreakpointOverride(page, nodeId, 'mobile', { fontSize: 18 })
    setBreakpointOverride(page, nodeId, 'mobile', { color: '#fff' })
    const overrides = page.nodes[nodeId].breakpointOverrides['mobile']
    expect(overrides).toEqual({ fontSize: 18, color: '#fff' })
  })

  it('different breakpoints are stored separately', () => {
    const { page, nodeId } = makeTestPage()
    setBreakpointOverride(page, nodeId, 'mobile', { fontSize: 14 })
    setBreakpointOverride(page, nodeId, 'tablet', { fontSize: 24 })
    expect(page.nodes[nodeId].breakpointOverrides['mobile'].fontSize).toBe(14)
    expect(page.nodes[nodeId].breakpointOverrides['tablet'].fontSize).toBe(24)
  })

  it('override does not affect other props at that breakpoint', () => {
    const { page, nodeId } = makeTestPage()
    page.nodes[nodeId].props = { color: '#000', fontSize: 32, text: 'Hello' }
    setBreakpointOverride(page, nodeId, 'mobile', { fontSize: 16 })
    // resolveProps at mobile: base props + mobile override
    const resolved = resolveProps(page.nodes[nodeId], 'mobile')
    expect(resolved.color).toBe('#000') // unchanged
    expect(resolved.fontSize).toBe(16)  // overridden
    expect(resolved.text).toBe('Hello') // unchanged
  })

  it('throws for non-existent nodeId', () => {
    const { page } = makeTestPage()
    expect(() =>
      setBreakpointOverride(page, 'nonexistent', 'mobile', { fontSize: 16 })
    ).toThrow()
  })

  it('is Mutative-safe', () => {
    const { page, nodeId } = makeTestPage()

    const nextPage = create(page, (draft) => {
      setBreakpointOverride(draft, nodeId, 'mobile', { fontSize: 16 })
    })

    expect(page.nodes[nodeId].breakpointOverrides['mobile']).toBeUndefined()
    expect(nextPage.nodes[nodeId].breakpointOverrides['mobile']).toEqual({ fontSize: 16 })
  })
})

// ---------------------------------------------------------------------------
// clearBreakpointOverride
// ---------------------------------------------------------------------------

describe('clearBreakpointOverride', () => {
  function makeTestPageWithOverride() {
    const page = makePage()
    const node = createNode('base.text', { color: '#000', fontSize: 32 })
    insertNode(page, node, page.rootNodeId)
    setBreakpointOverride(page, node.id, 'mobile', { fontSize: 16, color: '#fff' })
    setBreakpointOverride(page, node.id, 'tablet', { fontSize: 22 })
    return { page, nodeId: node.id }
  }

  it('removes all overrides for a given breakpoint', () => {
    const { page, nodeId } = makeTestPageWithOverride()
    clearBreakpointOverride(page, nodeId, 'mobile')
    expect(page.nodes[nodeId].breakpointOverrides['mobile']).toBeUndefined()
  })

  it('does not affect overrides for other breakpoints', () => {
    const { page, nodeId } = makeTestPageWithOverride()
    clearBreakpointOverride(page, nodeId, 'mobile')
    expect(page.nodes[nodeId].breakpointOverrides['tablet']).toEqual({ fontSize: 22 })
  })

  it('is a no-op for a breakpoint with no overrides', () => {
    const { page, nodeId } = makeTestPageWithOverride()
    expect(() => clearBreakpointOverride(page, nodeId, 'desktop')).not.toThrow()
    // tablet override should still be there
    expect(page.nodes[nodeId].breakpointOverrides['tablet']).toBeDefined()
  })

  it('is a no-op for non-existent nodeId (does not throw)', () => {
    const { page } = makeTestPageWithOverride()
    expect(() => clearBreakpointOverride(page, 'nonexistent', 'mobile')).not.toThrow()
  })

  it('after clearing, resolveProps returns base props at that breakpoint', () => {
    const { page, nodeId } = makeTestPageWithOverride()
    page.nodes[nodeId].props = { color: '#000', fontSize: 32 }

    // Before clear: mobile override applies
    expect(resolveProps(page.nodes[nodeId], 'mobile').fontSize).toBe(16)

    clearBreakpointOverride(page, nodeId, 'mobile')

    // After clear: base props apply
    expect(resolveProps(page.nodes[nodeId], 'mobile').fontSize).toBe(32)
    expect(resolveProps(page.nodes[nodeId], 'mobile').color).toBe('#000')
  })

  it('is Mutative-safe', () => {
    const { page, nodeId } = makeTestPageWithOverride()

    const nextPage = create(page, (draft) => {
      clearBreakpointOverride(draft, nodeId, 'mobile')
    })

    expect(page.nodes[nodeId].breakpointOverrides['mobile']).toBeDefined() // original unchanged
    expect(nextPage.nodes[nodeId].breakpointOverrides['mobile']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// roundtrip: set → resolve → clear → resolve
// ---------------------------------------------------------------------------

describe('breakpoint override roundtrip', () => {
  it('set → resolve at breakpoint → clear → resolve returns base', () => {
    const page = makePage()
    const node = createNode('base.text', { text: 'Desktop text', fontSize: 18 })
    insertNode(page, node, page.rootNodeId)

    // Set mobile override
    setBreakpointOverride(page, node.id, 'mobile', { text: 'Mobile text', fontSize: 14 })

    // Resolve at mobile — override should apply
    const mobileProps = resolveProps(page.nodes[node.id], 'mobile')
    expect(mobileProps.text).toBe('Mobile text')
    expect(mobileProps.fontSize).toBe(14)

    // Resolve at desktop — base props should apply
    const desktopProps = resolveProps(page.nodes[node.id], 'desktop')
    expect(desktopProps.text).toBe('Desktop text')
    expect(desktopProps.fontSize).toBe(18)

    // Clear mobile override
    clearBreakpointOverride(page, node.id, 'mobile')

    // Now resolve at mobile — base props should apply again
    const afterClear = resolveProps(page.nodes[node.id], 'mobile')
    expect(afterClear.text).toBe('Desktop text')
    expect(afterClear.fontSize).toBe(18)
  })
})
