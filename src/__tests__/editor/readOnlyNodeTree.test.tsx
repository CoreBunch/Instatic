/**
 * readOnlyNodeTree.test.tsx
 *
 * ReadOnlyNodeTree renders composed, non-editable canvas content (template
 * chrome, outlet previews, inlined VC bodies) and must be pixel-identical to
 * the published page. The publisher emits each node's `inlineStyles` as a
 * literal `style="…"` attribute (`injectNodeInlineStyles`), so the read-only
 * renderer must apply the same styles — through the same sanitisation gate —
 * or composed content renders visibly different from both the editable canvas
 * and the published output (e.g. a hero h1 with an inline
 * `font-size: clamp(…)` collapsing to the base heading size in a template's
 * outlet preview).
 */

import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import type { BaseNode } from '@core/page-tree'
import { bagToReactStyle } from '@core/publisher'
import { ReadOnlyNodeTree } from '@modules/base/utils/ReadOnlyNodeTree'
// Self-registering module imports — ReadOnlyNodeTree resolves components via
// the global registry.
import '@modules/base/text'

afterEach(cleanup)

function textNode(id: string, overrides: Partial<BaseNode> = {}): BaseNode {
  return {
    id,
    moduleId: 'base.text',
    props: { text: 'Own your site.', tag: 'h1', htmlAttributes: {} },
    breakpointOverrides: {},
    children: [],
    classIds: [],
    ...overrides,
  }
}

describe('ReadOnlyNodeTree — inline styles', () => {
  it('applies node.inlineStyles to the rendered element, matching the publisher', () => {
    // happy-dom cannot parse `clamp(…)` in a React style object (the value the
    // demo-site bug shipped) — its passthrough is asserted at the
    // bagToReactStyle level below; here we prove the DOM wiring with values
    // the test DOM can represent.
    const nodes: Record<string, BaseNode> = {
      h1: textNode('h1', {
        inlineStyles: { fontSize: '138px', letterSpacing: '-0.02em' },
      }),
    }
    const { container } = render(
      <ReadOnlyNodeTree nodes={nodes} rootNodeId="h1" classes={{}} />,
    )
    const h1 = container.querySelector('h1')
    expect(h1).not.toBeNull()
    expect(h1!.style.fontSize).toBe('138px')
    expect(h1!.style.letterSpacing).toBe('-0.02em')
  })

  it('drops unsafe values through the publisher sanitisation gate', () => {
    const nodes: Record<string, BaseNode> = {
      h1: textNode('h1', {
        inlineStyles: { color: 'red', backgroundImage: 'expression(alert(1))' },
      }),
    }
    const { container } = render(
      <ReadOnlyNodeTree nodes={nodes} rootNodeId="h1" classes={{}} />,
    )
    const h1 = container.querySelector('h1')!
    expect(h1.style.color).toBe('red')
    expect(h1.style.backgroundImage).toBe('')
  })

  it('renders no style attribute when the node has no inline styles', () => {
    const nodes: Record<string, BaseNode> = { h1: textNode('h1') }
    const { container } = render(
      <ReadOnlyNodeTree nodes={nodes} rootNodeId="h1" classes={{}} />,
    )
    expect(container.querySelector('h1')!.getAttribute('style')).toBeNull()
  })

  it('merges a forwarded root wrapper style OVER the node own inline styles (publisher append order)', () => {
    // Mirrors renderVisualComponentRef: the VC root's own inline styles render
    // first, then the ref node's styles are appended — so the forwarded
    // (owning-node) declarations win per property.
    const nodes: Record<string, BaseNode> = {
      h1: textNode('h1', {
        inlineStyles: { color: 'red', fontSize: '10px' },
      }),
    }
    const { container } = render(
      <ReadOnlyNodeTree
        nodes={nodes}
        rootNodeId="h1"
        classes={{}}
        rootNodeWrapperProps={{ style: { fontSize: '99px' } }}
      />,
    )
    const h1 = container.querySelector('h1')!
    expect(h1.style.fontSize).toBe('99px')
    expect(h1.style.color).toBe('red')
  })
})

describe('ReadOnlyNodeTree — dynamic preview context', () => {
  it('resolves currentEntry tokens in read-only template previews', () => {
    const nodes: Record<string, BaseNode> = {
      h1: textNode('h1', {
        props: { text: '{currentEntry.title}', tag: 'h1', htmlAttributes: {} },
      }),
    }
    const { container } = render(
      <ReadOnlyNodeTree
        nodes={nodes}
        rootNodeId="h1"
        classes={{}}
        templateContext={{ entryStack: [{ id: 'post-1', fields: { title: 'Dynamic Post' } }] }}
      />,
    )
    const h1 = container.querySelector('h1')
    expect(h1).not.toBeNull()
    expect(h1!.textContent).toBe('Dynamic Post')
  })
})

describe('bagToReactStyle', () => {
  it('passes fluid values like clamp() through unchanged', () => {
    expect(bagToReactStyle({ fontSize: 'clamp(46px, 10.5vw, 138px)' })).toEqual({
      fontSize: 'clamp(46px, 10.5vw, 138px)',
    })
  })

  it('drops unsafe and empty values, returns undefined when nothing survives', () => {
    expect(bagToReactStyle({ color: 'expression(alert(1))', width: '' })).toBeUndefined()
    expect(bagToReactStyle(undefined)).toBeUndefined()
    expect(bagToReactStyle({})).toBeUndefined()
  })
})
