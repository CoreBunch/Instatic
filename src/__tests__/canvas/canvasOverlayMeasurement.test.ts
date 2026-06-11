/**
 * Overlay measurement primitives used by the BreakpointSelectionOverlay RAF
 * tick:
 *
 *  - `createCanvasOverlayMeasureSession` must read the shared iframe /
 *    canvas-root geometry exactly ONCE per tick no matter how many rings it
 *    measures (the old code re-read them per ring).
 *  - `CanvasNodeElementCache` must resolve a tracked node's element without
 *    re-querying the document on every frame (the old code paid an
 *    O(document) `querySelector` scan per ring per frame).
 *
 * Everything is duck-typed DOM, so plain counting fakes keep these tests
 * deterministic — no happy-dom layout involved.
 */

import { describe, it, expect } from 'bun:test'
import {
  createCanvasOverlayMeasureSession,
  measureCanvasElementRect,
  unionCanvasOverlayRects,
} from '@site/canvas/canvasOverlayGeometry'
import { CanvasNodeElementCache } from '@site/canvas/canvasNodeLookup'

interface RectInit {
  left: number
  top: number
  width: number
  height: number
}

function domRect({ left, top, width, height }: RectInit): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

function fakeMeasurable(rect: RectInit) {
  let calls = 0
  return {
    element: {
      getBoundingClientRect: () => {
        calls++
        return domRect(rect)
      },
    } as unknown as HTMLElement,
    calls: () => calls,
  }
}

function fakeIframe(rect: RectInit, offsetWidth: number) {
  const measurable = fakeMeasurable(rect)
  return {
    iframe: Object.assign(measurable.element, { offsetWidth }) as unknown as HTMLIFrameElement,
    calls: measurable.calls,
  }
}

describe('createCanvasOverlayMeasureSession', () => {
  it('reads iframe and canvas-root geometry once per session, not per measured element', () => {
    const { iframe, calls: iframeCalls } = fakeIframe({ left: 100, top: 50, width: 400, height: 300 }, 400)
    const root = fakeMeasurable({ left: 10, top: 20, width: 800, height: 600 })

    const session = createCanvasOverlayMeasureSession(iframe, root.element)
    for (let i = 0; i < 25; i++) {
      session.measure(fakeMeasurable({ left: i, top: i, width: 10, height: 10 }).element)
    }

    expect(iframeCalls()).toBe(1)
    expect(root.calls()).toBe(1)
  })

  it('translates iframe-internal rects into canvas-root-local coords with zoom recovery', () => {
    // iframe client width 200 vs offsetWidth 400 → canvas zoom 0.5.
    const { iframe } = fakeIframe({ left: 100, top: 50, width: 200, height: 150 }, 400)
    const root = fakeMeasurable({ left: 10, top: 20, width: 800, height: 600 })
    const session = createCanvasOverlayMeasureSession(iframe, root.element)

    const rect = session.measure(fakeMeasurable({ left: 40, top: 60, width: 80, height: 30 }).element)
    expect(rect).toEqual({
      x: 100 + 40 * 0.5 - 10,
      y: 50 + 60 * 0.5 - 20,
      width: 80 * 0.5,
      height: 30 * 0.5,
    })
  })

  it('uses viewport (client) coordinates when no canvas root is wired in', () => {
    const { iframe } = fakeIframe({ left: 100, top: 50, width: 400, height: 300 }, 400)
    const session = createCanvasOverlayMeasureSession(iframe, null)
    expect(session.canvasRect).toBeNull()

    const rect = session.measure(fakeMeasurable({ left: 5, top: 6, width: 7, height: 8 }).element)
    expect(rect).toEqual({ x: 105, y: 56, width: 7, height: 8 })
  })

  it('returns null for missing, non-measurable, and zero-size targets', () => {
    const { iframe } = fakeIframe({ left: 0, top: 0, width: 400, height: 300 }, 400)
    const session = createCanvasOverlayMeasureSession(iframe, null)
    expect(session.measure(null)).toBeNull()
    expect(session.measure({} as HTMLElement)).toBeNull()
    expect(session.measure(fakeMeasurable({ left: 1, top: 1, width: 0, height: 0 }).element)).toBeNull()
  })

  it('matches the one-shot measureCanvasElementRect output', () => {
    const target = fakeMeasurable({ left: 40, top: 60, width: 80, height: 30 })
    const a = createCanvasOverlayMeasureSession(
      fakeIframe({ left: 100, top: 50, width: 200, height: 150 }, 400).iframe,
      null,
    ).measure(target.element)
    const b = measureCanvasElementRect(
      target.element,
      fakeIframe({ left: 100, top: 50, width: 200, height: 150 }, 400).iframe,
      null,
    )
    expect(b).toEqual(a)
  })

  it('one-shot helper does not touch the iframe when the target is null', () => {
    const { iframe, calls } = fakeIframe({ left: 0, top: 0, width: 400, height: 300 }, 400)
    expect(measureCanvasElementRect(null, iframe, null)).toBeNull()
    expect(calls()).toBe(0)
  })
})

describe('unionCanvasOverlayRects', () => {
  it('returns the second rect when accumulating from null', () => {
    const b = { x: 1, y: 2, width: 3, height: 4 }
    expect(unionCanvasOverlayRects(null, b)).toBe(b)
  })

  it('returns the smallest rect containing both inputs', () => {
    expect(
      unionCanvasOverlayRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: -5, width: 20, height: 10 }),
    ).toEqual({ x: 0, y: -5, width: 25, height: 15 })
  })
})

// ---------------------------------------------------------------------------
// CanvasNodeElementCache
// ---------------------------------------------------------------------------

interface FakeNodeElement {
  isConnected: boolean
  ownerDocument: unknown
}

function fakeDocument(elements: Record<string, FakeNodeElement | null>) {
  let queries = 0
  const doc = {
    querySelector(selector: string) {
      queries++
      const match = /\[data-node-id="(.*)"\]/.exec(selector)
      const el = match ? elements[match[1]] : null
      return el ?? null
    },
  } as unknown as Document
  // Wire ownerDocument so the cache's same-document check passes.
  for (const el of Object.values(elements)) {
    if (el) el.ownerDocument = doc
  }
  return { doc, queries: () => queries }
}

describe('CanvasNodeElementCache', () => {
  it('queries the document once per node while the element stays connected', () => {
    const el: FakeNodeElement = { isConnected: true, ownerDocument: null }
    const { doc, queries } = fakeDocument({ a: el })
    const cache = new CanvasNodeElementCache()

    // 60 ticks of the steady-state RAF loop → exactly one document scan.
    for (let i = 0; i < 60; i++) {
      expect(cache.resolve(doc, 'a')).toBe(el as unknown as HTMLElement)
    }
    expect(queries()).toBe(1)
  })

  it('re-queries when the cached element is disconnected (node re-rendered)', () => {
    const el: FakeNodeElement = { isConnected: true, ownerDocument: null }
    const { doc, queries } = fakeDocument({ a: el })
    const cache = new CanvasNodeElementCache()

    cache.resolve(doc, 'a')
    el.isConnected = false
    cache.resolve(doc, 'a')
    expect(queries()).toBe(2)
  })

  it('re-queries when the iframe swapped documents (stale ownerDocument)', () => {
    const el: FakeNodeElement = { isConnected: true, ownerDocument: null }
    const first = fakeDocument({ a: el })
    const cache = new CanvasNodeElementCache()
    cache.resolve(first.doc, 'a')

    const replacement: FakeNodeElement = { isConnected: true, ownerDocument: null }
    const second = fakeDocument({ a: replacement })
    expect(cache.resolve(second.doc, 'a')).toBe(replacement as unknown as HTMLElement)
    expect(second.queries()).toBe(1)
  })

  it('keeps re-querying (and drops the entry) while the node has no rendered element', () => {
    const { doc, queries } = fakeDocument({ a: null })
    const cache = new CanvasNodeElementCache()
    expect(cache.resolve(doc, 'a')).toBeNull()
    expect(cache.resolve(doc, 'a')).toBeNull()
    expect(queries()).toBe(2)
  })

  it('retainOnly drops untracked entries so they re-query on next resolve', () => {
    const a: FakeNodeElement = { isConnected: true, ownerDocument: null }
    const b: FakeNodeElement = { isConnected: true, ownerDocument: null }
    const { doc, queries } = fakeDocument({ a, b })
    const cache = new CanvasNodeElementCache()
    cache.resolve(doc, 'a')
    cache.resolve(doc, 'b')

    cache.retainOnly(new Set(['a']))
    cache.resolve(doc, 'a') // still cached
    expect(queries()).toBe(2)
    cache.resolve(doc, 'b') // pruned → fresh query
    expect(queries()).toBe(3)
  })
})
