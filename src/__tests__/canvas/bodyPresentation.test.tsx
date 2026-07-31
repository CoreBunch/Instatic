import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { classKindSelector, type StyleRule } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { makeNode, makePage, makeSite } from '../fixtures'
import { waitForCanvasFrameDocument } from './iframeCanvasQuery'
import '@modules/base'

const originalFetch = globalThis.fetch

function renderCanvas() {
  return render(<DndContext><CanvasRoot /></DndContext>)
}

function bodyNode(
  id: string,
  children: string[],
  backgroundColor: string,
  backgroundImage?: string,
) {
  return {
    ...makeNode({ id, moduleId: 'base.body', children }),
    inlineStyles: {
      backgroundColor,
      ...(backgroundImage ? { backgroundImage } : {}),
    },
  }
}

beforeEach(() => {
  cleanup()
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ value: null }), { status: 200 })) as typeof fetch
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    activeBreakpointId: 'desktop',
    activeConditionId: null,
    canvasView: 'design',
    collapsedBreakpointIds: [],
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('canvas iframe body presentation', () => {
  it('does not insert editor-only children before authored body content', async () => {
    const root = bodyNode('page-root', ['main'], 'rgb(12, 18, 24)')
    const main = makeNode({
      id: 'main',
      moduleId: 'base.container',
      props: { tag: 'main' },
    })
    const page = makePage({
      id: 'page',
      rootNodeId: root.id,
      nodes: { [root.id]: root, [main.id]: main },
    })

    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: page.id,
    } as Parameters<typeof useEditorStore.setState>[0])

    renderCanvas()
    const frameDocument = await waitForCanvasFrameDocument('desktop')

    await waitFor(() => {
      const firstChild = frameDocument.body.firstElementChild
      expect(firstChild?.tagName).toBe('MAIN')
      expect(firstChild?.getAttribute('data-node-id')).toBe(main.id)
      expect(firstChild?.matches(':first-child')).toBe(true)
      expect(frameDocument.body.children).toHaveLength(1)
    })
  })

  it('lets sanitized body attributes drive authored selector styling', async () => {
    const root = makeNode({
      id: 'page-root',
      moduleId: 'base.body',
      props: { htmlAttributes: { 'data-theme': 'dark' } },
    })
    const page = makePage({
      id: 'page',
      rootNodeId: root.id,
      nodes: { [root.id]: root },
    })
    const themeRule: StyleRule = {
      id: 'dark-body',
      name: 'body dark theme',
      kind: 'ambient',
      selector: 'body[data-theme="dark"]',
      order: 0,
      styles: { backgroundColor: 'rgb(6, 10, 18)' },
      contextStyles: {},
      createdAt: 0,
      updatedAt: 0,
    }

    useEditorStore.setState({
      site: makeSite({ pages: [page], styleRules: { [themeRule.id]: themeRule } }),
      activePageId: page.id,
    } as Parameters<typeof useEditorStore.setState>[0])

    renderCanvas()
    const frameDocument = await waitForCanvasFrameDocument('desktop')

    await waitFor(() => {
      expect(frameDocument.body.dataset.theme).toBe('dark')
      expect(frameDocument.body.matches('body[data-theme="dark"]')).toBe(true)
      expect(frameDocument.head.textContent).toContain('body[data-theme="dark"]')
      expect(frameDocument.head.textContent).toContain('background-color: rgb(6, 10, 18)')
    })
  })

  it('applies the active page body inline background to the real iframe body', async () => {
    const root = bodyNode(
      'page-root',
      [],
      'rgb(12, 18, 24)',
      'linear-gradient(rgb(12, 18, 24), rgb(24, 36, 48))',
    )
    root.inlineStyles = {
      ...root.inlineStyles,
      height: '40px',
      minHeight: '10px',
      overflow: 'scroll',
      overflowX: 'auto',
    }
    root.props.htmlAttributes = {
      id: 'site-body',
      role: 'document',
      'data-theme': 'dark',
      'data-breakpoint-id': 'forged',
    }
    const page = makePage({
      id: 'page',
      rootNodeId: root.id,
      nodes: { [root.id]: root },
    })

    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: page.id,
    } as Parameters<typeof useEditorStore.setState>[0])

    renderCanvas()
    const frameDocument = await waitForCanvasFrameDocument('desktop')

    await waitFor(() => {
      expect(frameDocument.body.style.backgroundColor).toBe('rgb(12, 18, 24)')
      expect(frameDocument.body.style.backgroundImage).toBe(
        'linear-gradient(rgb(12, 18, 24), rgb(24, 36, 48))',
      )
      expect(frameDocument.body.style.height).toBe('auto')
      expect(frameDocument.body.style.minHeight).toBe('800px')
      expect(frameDocument.body.style.overflow).toBe('hidden')
      expect(frameDocument.body.style.overflowX).toBe('')
      expect(frameDocument.body.id).toBe('site-body')
      expect(frameDocument.body.getAttribute('role')).toBe('document')
      expect(frameDocument.body.dataset.theme).toBe('dark')
      expect(frameDocument.body.dataset.breakpointId).toBe('desktop')
    })

    act(() => {
      useEditorStore.getState().setNodeInlineStyles(root.id, {
        backgroundColor: 'rgb(30, 42, 54)',
        height: '25px',
        minHeight: '5px',
        overflow: 'visible',
        overflowY: 'scroll',
      })
      useEditorStore.getState().updateNodeProps(root.id, {
        htmlAttributes: { dir: 'rtl', 'data-theme': 'dusk' },
      })
    })

    await waitFor(() => {
      expect(frameDocument.body.style.backgroundColor).toBe('rgb(30, 42, 54)')
      expect(frameDocument.body.style.height).toBe('auto')
      expect(frameDocument.body.style.minHeight).toBe('800px')
      expect(frameDocument.body.style.overflow).toBe('hidden')
      expect(frameDocument.body.style.overflowY).toBe('')
      expect(frameDocument.body.hasAttribute('id')).toBe(false)
      expect(frameDocument.body.getAttribute('dir')).toBe('rtl')
      expect(frameDocument.body.dataset.theme).toBe('dusk')
    })
  })

  it('keeps authored root sizing and overflow in the live published-behaviour frame', async () => {
    const root = bodyNode('page-root', [], 'rgb(20, 24, 32)')
    root.inlineStyles = {
      ...root.inlineStyles,
      height: '40px',
      minHeight: '10px',
      overflow: 'scroll',
    }
    const page = makePage({
      id: 'page',
      rootNodeId: root.id,
      nodes: { [root.id]: root },
    })

    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: page.id,
      canvasView: 'live',
    } as Parameters<typeof useEditorStore.setState>[0])

    renderCanvas()
    const frameDocument = await waitForCanvasFrameDocument('desktop')

    await waitFor(() => {
      expect(frameDocument.body.style.backgroundColor).toBe('rgb(20, 24, 32)')
      expect(frameDocument.body.style.height).toBe('40px')
      expect(frameDocument.body.style.minHeight).toBe('10px')
      expect(frameDocument.body.style.overflow).toBe('scroll')
    })
  })

  it('uses the outer wrapper body class and inline background, matching publisher ownership', async () => {
    const outerBodyClass: StyleRule = {
      id: 'outer-body-class',
      name: 'outer-body',
      kind: 'class',
      selector: classKindSelector('outer-body'),
      order: 0,
      styles: {},
      contextStyles: {},
      createdAt: 0,
      updatedAt: 0,
    }
    const wrapperRoot = {
      ...bodyNode('wrapper-root', ['outlet'], 'rgb(7, 11, 19)'),
      classIds: [outerBodyClass.id],
    }
    wrapperRoot.props.htmlAttributes = {
      id: 'outer-body',
      dir: 'rtl',
      'data-theme': 'outer-dark',
      'data-breakpoint-id': 'forged',
    }
    const outlet = makeNode({ id: 'outlet', moduleId: 'base.outlet' })
    const wrapper = makePage({
      id: 'wrapper',
      title: 'Everywhere',
      rootNodeId: wrapperRoot.id,
      nodes: { [wrapperRoot.id]: wrapperRoot, [outlet.id]: outlet },
      template: {
        enabled: true,
        target: { kind: 'everywhere' },
        priority: 100,
      },
    })
    const pageRoot = bodyNode('page-root', [], 'rgb(220, 30, 40)')
    pageRoot.props.htmlAttributes = {
      id: 'inner-body',
      'data-theme': 'inner-light',
    }
    const page = makePage({
      id: 'page',
      rootNodeId: pageRoot.id,
      nodes: { [pageRoot.id]: pageRoot },
    })

    useEditorStore.setState({
      site: makeSite({
        pages: [wrapper, page],
        styleRules: { [outerBodyClass.id]: outerBodyClass },
      }),
      activePageId: page.id,
    } as Parameters<typeof useEditorStore.setState>[0])

    renderCanvas()
    const frameDocument = await waitForCanvasFrameDocument('desktop')

    await waitFor(() => {
      expect(frameDocument.body.classList.contains('outer-body')).toBe(true)
      expect(frameDocument.body.style.backgroundColor).toBe('rgb(7, 11, 19)')
      expect(frameDocument.body.style.backgroundColor).not.toBe('rgb(220, 30, 40)')
      expect(frameDocument.body.id).toBe('outer-body')
      expect(frameDocument.body.dir).toBe('rtl')
      expect(frameDocument.body.dataset.theme).toBe('outer-dark')
      expect(frameDocument.body.dataset.breakpointId).toBe('desktop')
    })
  })

  it('removes editable body identity when switching to wrapped composition', async () => {
    const wrapperRoot = bodyNode('wrapper-root', ['outlet'], 'rgb(7, 11, 19)')
    const outlet = makeNode({ id: 'outlet', moduleId: 'base.outlet' })
    const wrapper = makePage({
      id: 'wrapper',
      title: 'Everywhere',
      rootNodeId: wrapperRoot.id,
      nodes: { [wrapperRoot.id]: wrapperRoot, [outlet.id]: outlet },
      template: {
        enabled: true,
        target: { kind: 'everywhere' },
        priority: 100,
      },
    })
    const pageRoot = bodyNode('page-root', [], 'rgb(20, 30, 40)')
    const page = makePage({
      id: 'page',
      rootNodeId: pageRoot.id,
      nodes: { [pageRoot.id]: pageRoot },
    })

    useEditorStore.setState({
      site: makeSite({ pages: [wrapper, page] }),
      activePageId: wrapper.id,
      selectedNodeId: wrapperRoot.id,
      selectedNodeIds: [wrapperRoot.id],
      hoveredNodeId: wrapperRoot.id,
    } as Parameters<typeof useEditorStore.setState>[0])

    renderCanvas()
    const frameDocument = await waitForCanvasFrameDocument('desktop')
    await waitFor(() => {
      expect(frameDocument.body.dataset.nodeId).toBe(wrapperRoot.id)
      expect(frameDocument.body.dataset.moduleId).toBe('base.body')
      expect(frameDocument.body.dataset.canvasSelected).toBe('true')
      expect(frameDocument.body.getAttribute('tabindex')).toBe('0')
    })

    act(() => {
      useEditorStore.setState({
        activePageId: page.id,
        selectedNodeId: null,
        selectedNodeIds: [],
        hoveredNodeId: null,
      })
    })

    await waitFor(() => {
      expect(frameDocument.body.hasAttribute('data-node-id')).toBe(false)
      expect(frameDocument.body.hasAttribute('data-module-id')).toBe(false)
      expect(frameDocument.body.hasAttribute('data-canvas-selected')).toBe(false)
      expect(frameDocument.body.hasAttribute('data-hovered')).toBe(false)
      expect(frameDocument.body.hasAttribute('tabindex')).toBe(false)
      expect(frameDocument.body.style.backgroundColor).toBe('rgb(7, 11, 19)')
    })
  })
})
