import { beforeEach, describe, expect, it } from 'bun:test'
import type { Page, PageNode } from '@core/page-tree'
import { reindexNodeParents } from '@core/page-tree'
import { resolveCanvasPointerInsertionDrop } from '@site/canvas/canvasInsertionDrop'
import '@modules/base/index'

function node(id: string, moduleId: string, children: string[] = []): PageNode {
  return {
    id,
    moduleId,
    props: {},
    breakpointOverrides: {},
    children,
  }
}

function page(nodes: Record<string, PageNode>, rootNodeId = 'root'): Page {
  reindexNodeParents(nodes)
  return {
    id: 'page',
    slug: 'index',
    title: 'Home',
    rootNodeId,
    nodes,
  }
}

function rect(init: { x: number; y: number; width: number; height: number }): DOMRect {
  return {
    x: init.x,
    y: init.y,
    left: init.x,
    top: init.y,
    right: init.x + init.width,
    bottom: init.y + init.height,
    width: init.width,
    height: init.height,
    toJSON: () => ({}),
  } as DOMRect
}

function setRect(element: HTMLElement, init: { x: number; y: number; width: number; height: number }) {
  element.getBoundingClientRect = () => rect(init)
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('resolveCanvasPointerInsertionDrop', () => {
  it('resolves a shared canvas insertion target and preview from a pointer position', () => {
    const tree = page({
      root: node('root', 'base.body', ['container']),
      container: node('container', 'base.container'),
    })

    const viewport = document.createElement('div')
    viewport.dataset.breakpointId = 'desktop'
    setRect(viewport, { x: 0, y: 0, width: 400, height: 400 })

    const container = document.createElement('section')
    container.dataset.nodeId = 'container'
    setRect(container, { x: 20, y: 20, width: 200, height: 120 })

    viewport.append(container)
    document.body.append(viewport)

    const resolved = resolveCanvasPointerInsertionDrop({
      canvasPage: tree,
      clientX: 100,
      clientY: 80,
      label: 'Drop image',
    })

    expect(resolved?.breakpointId).toBe('desktop')
    expect(resolved?.location).toEqual({ parentId: 'container', index: 0 })
    expect(resolved?.preview).toEqual({
      left: 20,
      top: 20,
      width: 200,
      height: 120,
      position: 'inside',
      label: 'Drop image inside',
    })
  })

  it('falls back to the page root when the pointer is inside a frame but not over a node', () => {
    const tree = page({
      root: node('root', 'base.body'),
    })

    const viewport = document.createElement('div')
    viewport.dataset.breakpointId = 'mobile'
    setRect(viewport, { x: 10, y: 20, width: 300, height: 400 })
    document.body.append(viewport)

    const resolved = resolveCanvasPointerInsertionDrop({
      canvasPage: tree,
      clientX: 30,
      clientY: 40,
      label: 'Drop video',
    })

    expect(resolved?.breakpointId).toBe('mobile')
    expect(resolved?.location).toEqual({ parentId: 'root', index: undefined })
    expect(resolved?.preview).toEqual({
      left: 10,
      top: 20,
      width: 300,
      height: 400,
      position: 'inside',
      label: 'Drop video at page root',
    })
  })
})
