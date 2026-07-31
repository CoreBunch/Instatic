import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

interface RasterOptions {
  backgroundColor?: string
  cacheBust?: boolean
  imagePlaceholder?: string
  pixelRatio?: number
  width?: number
  height?: number
  canvasWidth?: number
  canvasHeight?: number
  style?: Partial<CSSStyleDeclaration>
}

interface RasterCall {
  root: HTMLElement
  options: RasterOptions
  canvasWidth: number
  canvasHeight: number
  compositeOperation: string
  fillStyle: string
  fillRects: Array<[number, number, number, number]>
  saveCount: number
  restoreCount: number
  dataUrlType?: string
}

const rasterCalls: RasterCall[] = []
const toCanvasMock = mock(async (root: HTMLElement, options: RasterOptions = {}) => {
  const ratio = options.pixelRatio ?? 1
  const rect = root.getBoundingClientRect()
  // Canvas width/height use WebIDL integer conversion rather than rounding.
  const canvasWidth = Math.trunc((options.canvasWidth ?? options.width ?? rect.width) * ratio)
  const canvasHeight = Math.trunc((options.canvasHeight ?? options.height ?? rect.height) * ratio)
  const call: RasterCall = {
    root,
    options,
    canvasWidth,
    canvasHeight,
    compositeOperation: 'source-over',
    fillStyle: '',
    fillRects: [],
    saveCount: 0,
    restoreCount: 0,
  }
  const context = {
    get globalCompositeOperation() {
      return call.compositeOperation
    },
    set globalCompositeOperation(value: string) {
      call.compositeOperation = value
    },
    get fillStyle() {
      return call.fillStyle
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      call.fillStyle = String(value)
    },
    save() {
      call.saveCount += 1
    },
    restore() {
      call.restoreCount += 1
    },
    fillRect(x: number, y: number, width: number, height: number) {
      call.fillRects.push([x, y, width, height])
    },
  } as CanvasRenderingContext2D
  const canvas = {
    width: canvasWidth,
    height: canvasHeight,
    getContext: (type: string) => type === '2d' ? context : null,
    toDataURL: (type?: string) => {
      call.dataUrlType = type
      return 'data:image/png;base64,cG5n'
    },
  } as HTMLCanvasElement
  rasterCalls.push(call)
  return canvas
})

mock.module('html-to-image', () => ({ toCanvas: toCanvasMock }))

const { captureAgentRenderSnapshot, SnapshotNodeNotFoundError } = await import('@site/agent')

beforeEach(() => {
  document.body.innerHTML = ''
  rasterCalls.length = 0
  toCanvasMock.mockClear()
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
function mountFrame(
  breakpointId: string,
  viewportWidth: number = { mobile: 375, tablet: 768, desktop: 1440 }[breakpointId] ?? 1024,
  viewportHeight = 900,
): Document {
  const viewport = document.createElement('div')
  viewport.dataset.breakpointId = breakpointId
  const iframe = document.createElement('iframe')
  viewport.appendChild(iframe)
  document.body.appendChild(viewport)
  const doc = iframe.contentDocument
  if (!doc) throw new Error('iframe.contentDocument unavailable in test env')
  Object.defineProperties(doc.defaultView, {
    innerWidth: { configurable: true, value: viewportWidth },
    innerHeight: { configurable: true, value: viewportHeight },
  })
  return doc
}

describe('captureAgentRenderSnapshot — on-demand browser bridge', () => {
  it('rasterizes a node crop from the iframe document without replacing authored backgrounds', async () => {
    const doc = mountFrame('desktop', 2400, 1200)
    const html = doc.documentElement
    const body = doc.body
    html.style.backgroundColor = 'rgb(9, 9, 15)'
    body.style.backgroundImage = 'linear-gradient(black, rebeccapurple)'
    body.style.transform = 'translate(20px, 30px)'
    Object.defineProperties(html, {
      clientWidth: { configurable: true, value: 2400 },
      clientHeight: { configurable: true, value: 1200 },
      scrollWidth: { configurable: true, value: 2400 },
      scrollHeight: { configurable: true, value: 3000 },
    })
    Object.defineProperties(body, {
      clientWidth: { configurable: true, value: 2400 },
      clientHeight: { configurable: true, value: 3000 },
      scrollWidth: { configurable: true, value: 2400 },
      scrollHeight: { configurable: true, value: 3000 },
    })
    setRect(html, { x: 0, y: 0, width: 2400, height: 3000 })
    setRect(body, { x: 20, y: 30, width: 2400, height: 3000 })

    const hero = doc.createElement('section')
    hero.dataset.nodeId = 'hero'
    hero.dataset.moduleId = 'base.container'
    setRect(hero, { x: 120, y: 230, width: 2000, height: 1000 })
    body.appendChild(hero)

    const snapshot = await captureAgentRenderSnapshot({
      breakpointId: 'desktop',
      nodeId: 'hero',
      captureScreenshot: true,
    })

    expect(snapshot?.screenshot).toEqual({
      status: 'ok',
      mimeType: 'image/png',
      data: 'cG5n',
      width: 1568,
      height: 784,
    })
    expect(rasterCalls).toHaveLength(1)
    const call = rasterCalls[0]!
    expect(call.root).toBe(html)
    expect(call.root.querySelector('body')).toBe(body)
    expect(call.root.style.backgroundColor).not.toBe('')
    expect(body.style.backgroundImage).not.toBe('')
    expect(body.style.transform).not.toBe('')
    expect(call.options).not.toHaveProperty('backgroundColor')
    expect(call.options).toMatchObject({
      cacheBust: true,
      imagePlaceholder: '',
      pixelRatio: 1568 / 2000,
      width: 2000,
      height: 1000,
      canvasWidth: 2000,
      canvasHeight: 1000,
      style: {
        width: '2400px',
        height: '3030px',
        transform: 'translate(-120px, -230px)',
        transformOrigin: 'top left',
      },
    })
    expect(call.compositeOperation).toBe('destination-over')
    expect(call.fillStyle).toBe('#ffffff')
    expect(call.fillRects).toEqual([[0, 0, 1568, 784]])
    expect(call.saveCount).toBe(1)
    expect(call.restoreCount).toBe(1)
    expect(call.dataUrlType).toBe('image/png')
  })

  it('uses the iframe viewport and full document when the authored body is narrow and transformed', async () => {
    const doc = mountFrame('desktop', 1440, 900)
    const html = doc.documentElement
    const body = doc.body
    html.style.backgroundColor = 'rgb(9, 9, 15)'
    body.style.backgroundImage = 'linear-gradient(black, rebeccapurple)'
    body.style.maxWidth = '960px'
    body.style.transform = 'translateX(240px)'
    Object.defineProperties(html, {
      clientWidth: { configurable: true, value: 1440 },
      clientHeight: { configurable: true, value: 900 },
      scrollWidth: { configurable: true, value: 1440 },
      scrollHeight: { configurable: true, value: 2400 },
    })
    Object.defineProperties(body, {
      clientWidth: { configurable: true, value: 960 },
      clientHeight: { configurable: true, value: 2400 },
      scrollWidth: { configurable: true, value: 960 },
      scrollHeight: { configurable: true, value: 2400 },
    })
    setRect(html, { x: 0, y: 0, width: 1440, height: 2400 })
    setRect(body, { x: 240, y: 0, width: 960, height: 2400 })

    const heading = doc.createElement('h1')
    heading.dataset.nodeId = 'heading'
    heading.dataset.moduleId = 'base.text'
    setRect(heading, { x: 280, y: 80, width: 640, height: 96 })
    body.appendChild(heading)

    const snapshot = await captureAgentRenderSnapshot({
      breakpointId: 'desktop',
      captureScreenshot: true,
    })

    expect(snapshot?.width).toBe(1440)
    expect(snapshot?.layout.viewport).toEqual({
      width: 1440,
      height: 2400,
      scrollWidth: 1440,
      scrollHeight: 2400,
    })
    expect(snapshot?.layout.nodes[0]?.rect.x).toBe(280)
    expect(snapshot?.screenshot).toMatchObject({
      status: 'ok',
      width: 940,
      height: 1568,
    })

    expect(rasterCalls).toHaveLength(1)
    const call = rasterCalls[0]!
    expect(call.root).toBe(html)
    expect(call.root.querySelector('body')).toBe(body)
    expect(call.root.style.backgroundColor).not.toBe('')
    expect(body.style.backgroundImage).not.toBe('')
    expect(body.style.maxWidth).toBe('960px')
    expect(body.style.transform).not.toBe('')
    expect(call.options).not.toHaveProperty('backgroundColor')
    expect(call.options).toMatchObject({
      cacheBust: true,
      imagePlaceholder: '',
      pixelRatio: 1568 / 2400,
      width: 1440,
      height: 2400,
      canvasWidth: 1440,
      canvasHeight: 2400,
    })
    expect(call.options.style).toBeUndefined()
    expect(call.compositeOperation).toBe('destination-over')
    expect(call.fillStyle).toBe('#ffffff')
    expect(call.fillRects).toEqual([[0, 0, 940, 1568]])
  })

  it('captures every explicitly requested mounted breakpoint', async () => {
    const breakpoints = [
      { id: 'mobile', width: 375 },
      { id: 'tablet', width: 768 },
      { id: 'desktop', width: 1440 },
    ]
    for (const breakpoint of breakpoints) {
      const doc = mountFrame(breakpoint.id)
      setRect(doc.body, { x: 0, y: 0, width: breakpoint.width, height: 900 })
    }

    for (const breakpoint of breakpoints) {
      const snapshot = await captureAgentRenderSnapshot({
        breakpointId: breakpoint.id,
        captureScreenshot: false,
      })
      expect(snapshot?.breakpointId).toBe(breakpoint.id)
      expect(snapshot?.width).toBe(breakpoint.width)
    }
  })

  it('does not substitute the first frame when an explicit breakpoint is unavailable', async () => {
    const doc = mountFrame('desktop')
    setRect(doc.body, { x: 0, y: 0, width: 1440, height: 900 })

    const snapshot = await captureAgentRenderSnapshot({
      breakpointId: 'mobile',
      captureScreenshot: false,
    })

    expect(snapshot).toBeNull()
  })

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
    wrapper.style.backgroundImage = 'linear-gradient(red, blue)'
    wrapper.style.backgroundClip = 'text'
    wrapper.style.setProperty('-webkit-background-clip', 'text')
    wrapper.style.setProperty('-webkit-text-fill-color', 'transparent')
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
    expect(snapshot!.layout.nodes[0].computed).toMatchObject({
      backgroundImage: 'linear-gradient(red, blue)',
      backgroundClip: 'text',
      webkitBackgroundClip: 'text',
      webkitTextFillColor: 'transparent',
    })
    expect(snapshot!.layout.warnings.some((warning) =>
      warning.type === 'horizontal-overflow' && warning.nodeId === 'title',
    )).toBe(true)
  })

  it('distinguishes deferred lazy images from completed broken images', async () => {
    const doc = mountFrame('mobile')
    const deferredImage = doc.createElement('img')
    deferredImage.dataset.nodeId = 'deferred-image'
    deferredImage.src = '/uploads/deferred.png'
    deferredImage.loading = 'lazy'
    Object.defineProperties(deferredImage, {
      complete: { configurable: true, value: false },
      naturalWidth: { configurable: true, value: 0 },
      naturalHeight: { configurable: true, value: 0 },
    })
    setRect(deferredImage, { x: 0, y: 0, width: 320, height: 180 })

    const brokenImage = doc.createElement('img')
    brokenImage.dataset.nodeId = 'broken-image'
    brokenImage.src = '/uploads/missing.png'
    Object.defineProperties(brokenImage, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 0 },
      naturalHeight: { configurable: true, value: 0 },
    })
    setRect(brokenImage, { x: 0, y: 200, width: 320, height: 180 })
    doc.body.append(deferredImage, brokenImage)

    const snapshot = await captureAgentRenderSnapshot({
      breakpointId: 'mobile',
      captureScreenshot: false,
    })

    const brokenWarnings = snapshot!.layout.warnings.filter(
      (warning) => warning.type === 'broken-image',
    )
    expect(brokenWarnings).toHaveLength(1)
    expect(brokenWarnings[0]?.nodeId).toBe('broken-image')
    expect(snapshot!.layout.images.find((image) => image.nodeId === 'deferred-image')?.complete).toBe(false)
  })

  it('bounds computed background images before returning them as model-visible evidence', async () => {
    const doc = mountFrame('desktop')
    const node = doc.createElement('div')
    node.dataset.nodeId = 'large-background'
    node.style.backgroundImage = `url("data:image/png;base64,${'A'.repeat(1_000)}")`
    setRect(node, { width: 100, height: 100 })
    doc.body.appendChild(node)

    const snapshot = await captureAgentRenderSnapshot({
      breakpointId: 'desktop',
      captureScreenshot: false,
    })

    const backgroundImage = snapshot!.layout.nodes[0].computed.backgroundImage
    expect(backgroundImage).toHaveLength(500)
    expect(backgroundImage.endsWith('...[truncated]')).toBe(true)
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
