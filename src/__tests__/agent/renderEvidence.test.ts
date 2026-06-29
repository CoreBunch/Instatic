import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { captureAgentRenderSnapshot, SnapshotNodeNotFoundError } from '@site/agent'

beforeEach(() => {
  document.body.innerHTML = ''
})

// Clear DOM after each test too — these tests inject ad-hoc elements directly
// onto document.body (bypassing React testing-library's render+cleanup), so
// leftover nodes (e.g. [data-breakpoint-id="mobile"]) would otherwise leak
// into later suites that querySelector the same attributes.
afterEach(() => {
  document.body.innerHTML = ''
})

function setRect(el: Element, rect: Partial<DOMRectReadOnly>) {
  const full = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: rect.y ?? 0,
    left: rect.x ?? 0,
    right: (rect.x ?? 0) + (rect.width ?? 0),
    bottom: (rect.y ?? 0) + (rect.height ?? 0),
    toJSON: () => ({}),
    ...rect,
  } as DOMRect
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => full,
  })
}

/**
 * Mount a breakpoint the way the canvas actually does: a `[data-breakpoint-id]`
 * wrapper containing an <iframe> whose `contentDocument` holds the rendered
 * page nodes. Returns the iframe's document so the test can populate it.
 */
function mountFrame(breakpointId: string): Document {
  const viewport = document.createElement('div')
  viewport.dataset.breakpointId = breakpointId
  const iframe = document.createElement('iframe')
  viewport.appendChild(iframe)
  document.body.appendChild(viewport)
  const doc = iframe.contentDocument
  if (!doc) throw new Error('iframe.contentDocument unavailable in test env')
  return doc
}

describe('captureAgentRenderSnapshot — on-demand browser bridge', () => {
  it('captures breakpoint layout, node boxes, and overflow warnings from the canvas DOM', async () => {
    const doc = mountFrame('mobile')
    const body = doc.body
    Object.defineProperties(body, {
      clientWidth: { configurable: true, value: 375 },
      clientHeight: { configurable: true, value: 600 },
      scrollWidth: { configurable: true, value: 420 },
      scrollHeight: { configurable: true, value: 600 },
    })
    setRect(body, { x: 0, y: 0, width: 375, height: 600 })

    const wrapper = doc.createElement('div')
    wrapper.dataset.nodeId = 'title'
    wrapper.dataset.moduleId = 'base.text'
    wrapper.textContent = 'Overflowing headline'
    setRect(wrapper, { x: 8, y: 16, width: 420, height: 64 })
    body.appendChild(wrapper)

    const snapshot = await captureAgentRenderSnapshot({
      breakpointId: 'mobile',
      captureScreenshot: false,
    })

    expect(snapshot).not.toBeNull()
    expect(snapshot!.breakpointId).toBe('mobile')
    expect(snapshot!.layout.viewport.scrollWidth).toBe(420)
    expect(snapshot!.layout.nodes[0].nodeId).toBe('title')
    expect(snapshot!.layout.warnings.some((warning) =>
      warning.type === 'horizontal-overflow' && warning.nodeId === 'title',
    )).toBe(true)
  })

  it('scopes the capture to a node subtree when nodeId is given', async () => {
    const doc = mountFrame('desktop')

    const hero = doc.createElement('section')
    hero.dataset.nodeId = 'hero'
    hero.dataset.moduleId = 'base.container'
    Object.defineProperties(hero, {
      clientWidth: { configurable: true, value: 1440 },
      clientHeight: { configurable: true, value: 500 },
      scrollWidth: { configurable: true, value: 1440 },
      scrollHeight: { configurable: true, value: 500 },
    })
    setRect(hero, { x: 0, y: 100, width: 1440, height: 500 })

    const heading = doc.createElement('h1')
    heading.dataset.nodeId = 'hero-title'
    heading.dataset.moduleId = 'base.text'
    heading.textContent = 'Welcome'
    setRect(heading, { x: 40, y: 140, width: 600, height: 80 })
    hero.appendChild(heading)

    const footer = doc.createElement('div')
    footer.dataset.nodeId = 'footer'
    setRect(footer, { x: 0, y: 3800, width: 1440, height: 200 })

    doc.body.append(hero, footer)

    const snapshot = await captureAgentRenderSnapshot({
      breakpointId: 'desktop',
      nodeId: 'hero',
      captureScreenshot: false,
    })

    expect(snapshot).not.toBeNull()
    expect(snapshot!.nodeId).toBe('hero')
    expect(snapshot!.layout.nodeId).toBe('hero')
    // Viewport reflects the scoped root (the hero), not the whole 4000px page.
    expect(snapshot!.layout.viewport.height).toBe(500)
    expect(snapshot!.width).toBe(1440)
    // The root node itself is included, plus its descendant — not the sibling footer.
    const ids = snapshot!.layout.nodes.map((n) => n.nodeId)
    expect(ids).toEqual(['hero', 'hero-title'])
    // Coordinates are relative to the hero's box (hero y=100 → heading y=40).
    const headingNode = snapshot!.layout.nodes.find((n) => n.nodeId === 'hero-title')!
    expect(headingNode.rect.y).toBe(40)
  })

  it('throws SnapshotNodeNotFoundError when nodeId is absent from the frame', async () => {
    const doc = mountFrame('desktop')
    setRect(doc.body, { x: 0, y: 0, width: 1440, height: 900 })

    await expect(
      captureAgentRenderSnapshot({ breakpointId: 'desktop', nodeId: 'ghost', captureScreenshot: false }),
    ).rejects.toBeInstanceOf(SnapshotNodeNotFoundError)
  })

  it('returns null when no canvas frame is mounted', async () => {
    const snapshot = await captureAgentRenderSnapshot({
      breakpointId: 'mobile',
      captureScreenshot: false,
    })
    expect(snapshot).toBeNull()
  })

  it('falls back to the first canvas frame when no breakpointId is provided', async () => {
    const doc = mountFrame('desktop')
    Object.defineProperties(doc.body, {
      clientWidth: { configurable: true, value: 1440 },
      clientHeight: { configurable: true, value: 900 },
      scrollWidth: { configurable: true, value: 1440 },
      scrollHeight: { configurable: true, value: 900 },
    })
    setRect(doc.body, { x: 0, y: 0, width: 1440, height: 900 })

    const snapshot = await captureAgentRenderSnapshot({
      captureScreenshot: false,
    })
    expect(snapshot?.breakpointId).toBe('desktop')
  })
})
