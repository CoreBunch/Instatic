import { describe, expect, it } from 'bun:test'
import { canNodeInlineTextEdit } from '@site/canvas/canvasInlineTextEdit'
import { makeNode, makePage, makeSite } from '../fixtures'
import type { EditorStore } from '@site/store/types'
import '@modules/base'

function storeWithTextNode(overrides: Partial<ReturnType<typeof makeNode>> = {}): EditorStore {
  const text = makeNode({
    id: 'text-1',
    moduleId: 'base.text',
    props: { text: 'Hello', tag: 'p' },
    children: [],
    ...overrides,
  })
  const root = makeNode({ id: 'root', moduleId: 'base.body', children: ['text-1'] })
  const page = makePage({ rootNodeId: 'root', nodes: { root, 'text-1': text } })
  return {
    site: makeSite({ pages: [page] }),
    activePageId: page.id,
    activeDocument: null,
  } as EditorStore
}

describe('canNodeInlineTextEdit', () => {
  it('allows base.text with a string prop', () => {
    const state = storeWithTextNode()
    expect(canNodeInlineTextEdit(state, 'text-1')).toBe(true)
  })

  it('blocks link nodes that render children instead of text', () => {
    const state = storeWithTextNode({
      id: 'link-1',
      moduleId: 'base.link',
      props: { text: 'Link', href: '#' },
      children: ['child'],
    })
    expect(canNodeInlineTextEdit(state, 'link-1')).toBe(false)
  })
})
