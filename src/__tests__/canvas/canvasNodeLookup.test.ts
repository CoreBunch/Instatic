import { afterEach, describe, expect, it } from 'bun:test'
import {
  escapeCssAttributeValue,
  findRenderedCanvasNodeElement,
} from '@site/canvas/canvasNodeLookup'

afterEach(() => {
  document.body.innerHTML = ''
})

/** Append an iframe whose body is tagged as a canvas breakpoint frame. */
function addCanvasFrame(html: string, breakpointId = 'bp-desktop'): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const frameDoc = frame.contentDocument
  if (!frameDoc) throw new Error('Test iframe did not create a contentDocument')
  frameDoc.body.setAttribute('data-breakpoint-id', breakpointId)
  frameDoc.body.innerHTML = html
  return frame
}

describe('findRenderedCanvasNodeElement', () => {
  it('resolves the node inside a canvas breakpoint frame', () => {
    addCanvasFrame('<h1 data-node-id="title" class="title"></h1>')

    const el = findRenderedCanvasNodeElement('title')

    expect(el).not.toBeNull()
    expect(el?.tagName).toBe('H1')
    expect(el?.ownerDocument.body.getAttribute('data-breakpoint-id')).toBe('bp-desktop')
  })

  it('never resolves admin-document elements carrying the same data-node-id', () => {
    // The DOM panel's tree rows, the Import-HTML preview rows, and the
    // selection/hover overlay rings all render `data-node-id` into the ADMIN
    // document. None of them are the rendered node.
    const treeRow = document.createElement('div')
    treeRow.setAttribute('data-node-id', 'title')
    document.body.appendChild(treeRow)

    expect(findRenderedCanvasNodeElement('title')).toBeNull()

    addCanvasFrame('<h1 data-node-id="title"></h1>')
    const el = findRenderedCanvasNodeElement('title')
    expect(el?.tagName).toBe('H1')
    expect(el).not.toBe(treeRow)
  })

  it('ignores iframes that are not canvas breakpoint frames', () => {
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const frameDoc = frame.contentDocument
    if (!frameDoc) throw new Error('Test iframe did not create a contentDocument')
    // No data-breakpoint-id on the body — e.g. a plugin or preview iframe.
    frameDoc.body.innerHTML = '<div data-node-id="title"></div>'

    expect(findRenderedCanvasNodeElement('title')).toBeNull()
  })

  it('returns null when the node is rendered nowhere', () => {
    addCanvasFrame('<h1 data-node-id="other"></h1>')
    expect(findRenderedCanvasNodeElement('title')).toBeNull()
  })

  it('escapes quotes and backslashes in the node id', () => {
    expect(escapeCssAttributeValue('a"b\\c')).toBe('a\\"b\\\\c')
    // Must not throw on a hostile id.
    expect(findRenderedCanvasNodeElement('a"b\\c')).toBeNull()
  })
})
