import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import type { AiToolOutput } from '@core/ai'
import { DEFAULT_BREAKPOINTS, type Breakpoint } from '@core/page-tree'
import { DEFAULT_MODULE_INSERTER_PREFERENCE } from '@core/persistence/userPreferences'
import {
  executeAgentTool,
  findAgentRenderFrame,
  waitForAgentRenderFrame,
} from '@site/agent'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { useEditorStore } from '@site/store/store'
import { __resetModuleInserterPreferenceForTests } from '@site/module-picker/useModuleInserterPreference'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const originalFetch = globalThis.fetch

const BREAKPOINTS: Breakpoint[] = DEFAULT_BREAKPOINTS.map((breakpoint) => ({
  ...breakpoint,
  previewFrame: breakpoint.id !== 'mobile',
}))

const POSTS_TABLE = {
  id: 'posts',
  name: 'Posts',
  slug: 'posts',
  kind: 'postType',
  routeBase: '/posts',
  singularLabel: 'Post',
  pluralLabel: 'Posts',
  primaryFieldId: 'title',
  fields: [
    { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
  ],
  system: true,
  rowCount: 1,
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: '2026-07-11T10:00:00.000Z',
  updatedAt: '2026-07-11T10:00:00.000Z',
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  cleanup()
  document.body.replaceChildren()
  __resetModuleInserterPreferenceForTests()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/admin/api/cms/me/preferences/module-inserter')) {
      return new Response(JSON.stringify({ value: DEFAULT_MODULE_INSERTER_PREFERENCE }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('', { status: 404 })
  }) as typeof globalThis.fetch

  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['headline'] }),
      headline: makeNode({
        id: 'headline',
        moduleId: 'base.text',
        props: { text: 'Breakpoint evidence', tag: 'h1' },
      }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page], breakpoints: BREAKPOINTS }),
    activePageId: page.id,
    activeDocument: null,
    activeBreakpointId: 'desktop',
    activeConditionId: null,
    canvasView: 'live',
    runScripts: false,
    collapsedBreakpointIds: ['tablet'],
    agentSnapshotCaptureRequest: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    previewClassAssignment: null,
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
    propertiesPanelMode: 'docked',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  globalThis.fetch = originalFetch
  __resetModuleInserterPreferenceForTests()
  useEditorStore.setState({
    agentSnapshotCaptureRequest: null,
    collapsedBreakpointIds: [],
    canvasView: 'design',
    runScripts: false,
  })
})

describe('agent breakpoint snapshot capture', () => {
  it('mounts one exact-width transient frame without runtime scripts', async () => {
    render(<CanvasRoot />)

    act(() => {
      useEditorStore.getState().setAgentSnapshotCaptureRequest({
        requestId: 'manual-mobile-capture',
        breakpointId: 'mobile',
      })
    })

    let frame: HTMLElement | null = null
    await act(async () => {
      frame = await waitForAgentRenderFrame({
        breakpointId: 'mobile',
        source: 'transient',
        requestId: 'manual-mobile-capture',
      })
    })
    expect(frame).not.toBeNull()
    const iframe = frame!.querySelector('iframe')
    expect(iframe?.style.width).toBe('375px')
    expect(iframe?.dataset.instaticCanvasDocumentLoaded).toBe('true')
    expect(iframe?.dataset.agentSnapshotReady).toBe('manual-mobile-capture')
    expect(iframe?.contentDocument?.documentElement.hasAttribute(
      'data-instatic-canvas-document',
    )).toBe(false)
    expect(iframe?.contentDocument?.querySelector('[data-instatic-canvas-runtime-script]')).toBeNull()
    expect(iframe?.contentDocument?.body.querySelector('[data-instatic-body-probe]')).toBeNull()
    expect(iframe?.contentDocument?.body.hasAttribute('data-agent-snapshot-ready')).toBe(false)
    expect(iframe?.contentDocument?.body.children).toHaveLength(1)
    expect(iframe?.contentDocument?.body.firstElementChild?.getAttribute('data-node-id')).toBe('headline')
    expect(findAgentRenderFrame({ breakpointId: 'mobile', source: 'visible' })).toBeNull()

    act(() => useEditorStore.getState().setAgentSnapshotCaptureRequest(null))
    await waitFor(() => {
      expect(findAgentRenderFrame({ breakpointId: 'mobile', source: 'transient' })).toBeNull()
    })
  })

  it('ignores the initial about:blank portal until the loaded document commits', () => {
    const requestId = 'replacement-race'
    const frame = document.createElement('div')
    frame.dataset.agentSnapshotFrame = ''
    frame.dataset.agentSnapshotRequestId = requestId
    frame.dataset.agentSnapshotBreakpointId = 'mobile'
    const iframe = document.createElement('iframe')
    frame.appendChild(iframe)
    document.body.appendChild(frame)

    const initialDocument = document.implementation.createHTMLDocument('initial')
    initialDocument.body.dataset.breakpointId = 'mobile'
    initialDocument.body.dataset.agentSnapshotReady = requestId
    const loadedDocument = document.implementation.createHTMLDocument('loaded')
    loadedDocument.body.dataset.breakpointId = 'mobile'
    let currentDocument = initialDocument
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      get: () => currentDocument,
    })

    const query = {
      breakpointId: 'mobile',
      source: 'transient' as const,
      requestId,
      requireReady: true,
    }
    expect(findAgentRenderFrame(query)).toBeNull()

    // The srcDoc load replaces the initial document. Its React portal has not
    // committed yet, so the iframe load marker alone is still insufficient.
    currentDocument = loadedDocument
    iframe.dataset.instaticCanvasDocumentLoaded = 'true'
    expect(findAgentRenderFrame(query)).toBeNull()

    iframe.dataset.agentSnapshotReady = requestId
    expect(findAgentRenderFrame(query)).toBe(frame)
  })

  it('captures a frameless breakpoint from live mode without changing visible canvas state', async () => {
    render(<CanvasRoot />)
    const before = visibleCanvasState()
    const requests: string[] = []
    const unsubscribe = useEditorStore.subscribe((state) => {
      const breakpointId = state.agentSnapshotCaptureRequest?.breakpointId
      if (breakpointId) requests.push(breakpointId)
    })

    let capturePromise!: Promise<AiToolOutput>
    act(() => {
      capturePromise = executeAgentTool('site_render_snapshot', {
        breakpointId: 'mobile',
        captureScreenshot: false,
      })
    })
    const result = await act(async () => await capturePromise)
    unsubscribe()

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ breakpointId: 'mobile' })
    expect(requests).toContain('mobile')
    expect(visibleCanvasState()).toEqual(before)
    expect(useEditorStore.getState().agentSnapshotCaptureRequest).toBeNull()
  })

  it('does not reuse a live frame clamped below the configured viewport width', async () => {
    render(<CanvasRoot />)
    let visibleFrame: HTMLElement | null = null
    await act(async () => {
      visibleFrame = await waitForAgentRenderFrame({
        breakpointId: 'desktop',
        source: 'visible',
      })
    })
    const iframeWindow = visibleFrame!.querySelector('iframe')!.contentWindow!
    Object.defineProperty(iframeWindow, 'innerWidth', {
      configurable: true,
      value: 800,
    })

    const requests: string[] = []
    const unsubscribe = useEditorStore.subscribe((state) => {
      const breakpointId = state.agentSnapshotCaptureRequest?.breakpointId
      if (breakpointId) requests.push(breakpointId)
    })
    let capturePromise!: Promise<AiToolOutput>
    act(() => {
      capturePromise = executeAgentTool('site_render_snapshot', {
        breakpointId: 'desktop',
        captureScreenshot: false,
      })
    })
    const result = await act(async () => await capturePromise)
    unsubscribe()

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ breakpointId: 'desktop' })
    expect(requests).toContain('desktop')
    expect(useEditorStore.getState().activeBreakpointId).toBe('desktop')
    expect(useEditorStore.getState().canvasView).toBe('live')
  })

  it('uses the readiness-aware transient frame even when a visible frame is exact', async () => {
    useEditorStore.setState({ canvasView: 'design' })
    render(<CanvasRoot />)
    let visibleFrame: HTMLElement | null = null
    await act(async () => {
      visibleFrame = await waitForAgentRenderFrame({
        breakpointId: 'desktop',
        source: 'visible',
      })
    })
    Object.defineProperty(visibleFrame!.querySelector('iframe')!.contentWindow!, 'innerWidth', {
      configurable: true,
      value: 1440,
    })

    const requests: string[] = []
    const unsubscribe = useEditorStore.subscribe((state) => {
      const breakpointId = state.agentSnapshotCaptureRequest?.breakpointId
      if (breakpointId) requests.push(breakpointId)
    })
    const result = await act(async () => await executeAgentTool('site_render_snapshot', {
      breakpointId: 'desktop',
      captureScreenshot: false,
    }))
    unsubscribe()

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ breakpointId: 'desktop' })
    expect(requests).toEqual(['desktop'])
  })

  it('captures a collapsed design frame without expanding it', async () => {
    useEditorStore.setState({ canvasView: 'design' })
    render(<CanvasRoot />)
    expect(findAgentRenderFrame({ breakpointId: 'tablet', source: 'visible' })).toBeNull()
    const before = visibleCanvasState()

    let capturePromise!: Promise<AiToolOutput>
    act(() => {
      capturePromise = executeAgentTool('site_render_snapshot', {
        breakpointId: 'tablet',
        captureScreenshot: false,
      })
    })
    const result = await act(async () => await capturePromise)

    expect(result.ok).toBe(true)
    expect(result.data).toMatchObject({ breakpointId: 'tablet' })
    expect(visibleCanvasState()).toEqual(before)
    expect(useEditorStore.getState().collapsedBreakpointIds).toContain('tablet')
  })

  it('waits for delayed loop preview data before marking and capturing the frame', async () => {
    const tableGate = deferred()
    const rowsGate = deferred()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/admin/api/cms/me/preferences/module-inserter')) {
        return jsonResponse({ value: DEFAULT_MODULE_INSERTER_PREFERENCE })
      }
      if (url === '/admin/api/cms/data/tables/posts') {
        await tableGate.promise
        return jsonResponse({ table: POSTS_TABLE })
      }
      if (url.startsWith('/admin/api/cms/data/tables/posts/loop-preview')) {
        await rowsGate.promise
        return jsonResponse({
          items: [{ id: 'post-1', fields: { title: 'Delayed loop row' } }],
          totalItems: 1,
        })
      }
      return new Response('', { status: 404 })
    }) as typeof globalThis.fetch

    const root = makeNode({ id: 'root', moduleId: 'base.body', children: ['loop'] })
    const loop = makeNode({
      id: 'loop',
      moduleId: 'base.loop',
      props: {
        sourceId: 'data.rows',
        filters: { tableId: 'posts' },
        orderBy: 'publishedAt',
        direction: 'desc',
        limit: 3,
        offset: 0,
        tag: 'section',
      },
      children: ['loop-title'],
    })
    const title = makeNode({
      id: 'loop-title',
      moduleId: 'base.text',
      props: { text: '{currentEntry.title}', tag: 'h2' },
    })
    const page = makePage({
      id: 'loop-page',
      rootNodeId: root.id,
      nodes: { [root.id]: root, [loop.id]: loop, [title.id]: title },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page], breakpoints: BREAKPOINTS }),
      activePageId: page.id,
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<CanvasRoot />)
    let settled = false
    let capturePromise!: Promise<AiToolOutput>
    act(() => {
      capturePromise = executeAgentTool('site_render_snapshot', {
        breakpointId: 'mobile',
        captureScreenshot: false,
      })
      void capturePromise.then(() => {
        settled = true
      })
    })

    let transientFrame: HTMLElement | null = null
    await waitFor(() => {
      transientFrame = findAgentRenderFrame({ breakpointId: 'mobile', source: 'transient' })
      expect(transientFrame).not.toBeNull()
    })
    expect(transientFrame!.querySelector('iframe')?.dataset.agentSnapshotReady).toBeUndefined()
    expect(settled).toBe(false)

    await act(async () => {
      tableGate.resolve()
      await Promise.resolve()
    })
    expect(settled).toBe(false)
    expect(transientFrame!.querySelector('iframe')?.dataset.agentSnapshotReady).toBeUndefined()

    await act(async () => {
      rowsGate.resolve()
      await Promise.resolve()
    })
    const result = await act(async () => await capturePromise)
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result.data)).toContain('Delayed loop row')
  })

  it('waits for a post-type template preview row before capturing bindings', async () => {
    const tablesGate = deferred()
    const rowsGate = deferred()
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/admin/api/cms/me/preferences/module-inserter')) {
        return jsonResponse({ value: DEFAULT_MODULE_INSERTER_PREFERENCE })
      }
      if (url === '/admin/api/cms/data/tables') {
        await tablesGate.promise
        return jsonResponse({ tables: [POSTS_TABLE] })
      }
      if (url.startsWith('/admin/api/cms/data/tables/posts/loop-preview')) {
        await rowsGate.promise
        return jsonResponse({
          items: [{ id: 'post-1', fields: { title: 'Delayed template row' } }],
          totalItems: 1,
        })
      }
      return new Response('', { status: 404 })
    }) as typeof globalThis.fetch

    const root = makeNode({ id: 'template-root', moduleId: 'base.body', children: ['title'] })
    const title = makeNode({
      id: 'title',
      moduleId: 'base.text',
      props: { text: 'Fallback title', tag: 'h1' },
      dynamicBindings: {
        text: { source: 'currentEntry', field: 'title' },
      },
    })
    const template = makePage({
      id: 'post-template',
      rootNodeId: root.id,
      nodes: { [root.id]: root, [title.id]: title },
      template: {
        enabled: true,
        target: { kind: 'postTypes', tableSlugs: ['posts'] },
        priority: 100,
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [template], breakpoints: BREAKPOINTS }),
      activePageId: template.id,
      activeDocument: { kind: 'page', pageId: template.id },
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<CanvasRoot />)
    let settled = false
    let capturePromise!: Promise<AiToolOutput>
    act(() => {
      capturePromise = executeAgentTool('site_render_snapshot', {
        breakpointId: 'mobile',
        captureScreenshot: false,
      })
      void capturePromise.then(() => {
        settled = true
      })
    })

    await waitFor(() => {
      expect(findAgentRenderFrame({ breakpointId: 'mobile', source: 'transient' })).not.toBeNull()
    })
    expect(settled).toBe(false)

    await act(async () => {
      tablesGate.resolve()
      await Promise.resolve()
    })
    expect(settled).toBe(false)

    await act(async () => {
      rowsGate.resolve()
      await Promise.resolve()
    })
    const result = await act(async () => await capturePromise)
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result.data)).toContain('Delayed template row')
    expect(JSON.stringify(result.data)).not.toContain('Fallback title')
  })

  it('serializes parallel captures that both need the one transient frame', async () => {
    useEditorStore.setState({ canvasView: 'design' })
    render(<CanvasRoot />)
    const before = visibleCanvasState()
    const requests: string[] = []
    const unsubscribe = useEditorStore.subscribe((state) => {
      const breakpointId = state.agentSnapshotCaptureRequest?.breakpointId
      if (breakpointId && requests.at(-1) !== breakpointId) requests.push(breakpointId)
    })

    const [mobileResult, tabletResult] = await act(async () => await Promise.all([
      executeAgentTool('site_render_snapshot', {
        breakpointId: 'mobile',
        captureScreenshot: false,
      }),
      executeAgentTool('site_render_snapshot', {
        breakpointId: 'tablet',
        captureScreenshot: false,
      }),
    ]))
    unsubscribe()

    expect(mobileResult).toMatchObject({ ok: true, data: { breakpointId: 'mobile' } })
    expect(tabletResult).toMatchObject({ ok: true, data: { breakpointId: 'tablet' } })
    expect(requests).toEqual(['mobile', 'tablet'])
    expect(visibleCanvasState()).toEqual(before)
    expect(useEditorStore.getState().agentSnapshotCaptureRequest).toBeNull()
  })

  it('rejects an unknown breakpoint without mounting a fallback frame', async () => {
    render(<CanvasRoot />)
    await act(async () => {
      await waitForAgentRenderFrame({
        breakpointId: 'desktop',
        source: 'visible',
      })
    })
    const result = await act(async () => await executeAgentTool('site_render_snapshot', {
      breakpointId: 'invented-phone',
      captureScreenshot: false,
    }))

    expect(result).toEqual({ ok: false, error: 'Breakpoint not found: invented-phone' })
    expect(useEditorStore.getState().agentSnapshotCaptureRequest).toBeNull()
    expect(findAgentRenderFrame({
      breakpointId: 'invented-phone',
      source: 'transient',
    })).toBeNull()
  })
})

function visibleCanvasState() {
  const state = useEditorStore.getState()
  return {
    activeBreakpointId: state.activeBreakpointId,
    canvasView: state.canvasView,
    collapsedBreakpointIds: [...state.collapsedBreakpointIds],
  }
}
