import { describe, expect, it } from 'bun:test'
import { isNode, collectSameOriginDocuments } from '@ui/lib/sameOriginDocuments'

describe('isNode', () => {
  it('accepts a same-realm node', () => {
    const el = document.createElement('div')
    expect(isNode(el)).toBe(true)
  })

  it('rejects null and non-node event targets', () => {
    expect(isNode(null)).toBe(false)
    // A plain EventTarget (e.g. window/XHR) has no numeric nodeType.
    expect(isNode({ addEventListener() {} } as unknown as EventTarget)).toBe(false)
  })

  it('accepts a cross-realm node by structure, where `instanceof Node` fails', () => {
    // A node from inside an iframe is an instance of the *iframe's* Node, not
    // this realm's — so `instanceof Node` is false for it. `isNode` must still
    // accept it (this is the canvas context-menu dismiss bug). We simulate the
    // cross-realm node with an object that quacks like a Node but is not an
    // `instanceof Node` of this realm.
    const fakeForeignNode = { nodeType: 1, nodeName: 'DIV' } as unknown as EventTarget
    expect(fakeForeignNode instanceof Node).toBe(false)
    expect(isNode(fakeForeignNode)).toBe(true)
  })
})

describe('collectSameOriginDocuments', () => {
  it('includes the root document', () => {
    const docs = collectSameOriginDocuments(document)
    expect(docs).toContain(document)
  })

  it('includes a same-origin iframe document', () => {
    const iframe = document.createElement('iframe')
    iframe.srcdoc = '<body></body>'
    document.body.appendChild(iframe)
    try {
      const childDoc = iframe.contentDocument
      expect(childDoc).not.toBeNull()
      const docs = collectSameOriginDocuments(document)
      expect(docs).toContain(childDoc as Document)
    } finally {
      iframe.remove()
    }
  })
})
