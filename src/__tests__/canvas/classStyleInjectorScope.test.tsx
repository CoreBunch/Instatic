import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { ClassStyleInjector } from '@site/canvas/ClassStyleInjector'
import { createCanvasStyleRuleIdSelector } from '@site/canvas/canvasStyleUsage'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { collectUsedStyleRuleIds, collectPageStyleRuleIds } from '@core/publisher'
import { DEFAULT_SCRIPT_RUNTIME_CONFIG } from '@core/site-runtime'
import type { StyleRule } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import { makePage, makeSite, makeNode } from '../fixtures'

function rule(id: string, selector = `.${id}`): StyleRule {
  return { id, name: id, kind: 'class', selector, styles: { color: 'green' }, contextStyles: {}, order: 0, createdAt: 0, updatedAt: 0 }
}
function css(id = 'mc-classes'): string {
  return document.getElementById(id)?.textContent ?? ''
}
function clearStore() {
  useEditorStore.setState({ site: null, activePageId: null, activeDocument: null, selectedNodeId: null, activeClassId: null, previewClassStyles: null, previewClassAssignment: null, runScripts: false })
}

describe('ClassStyleInjector active document scope', () => {
  beforeEach(() => { cleanup(); document.head.replaceChildren(); clearStore() })
  afterEach(() => { cleanup(); document.head.replaceChildren(); clearStore() })

  it('switches page CSS immediately and paints temporary class assignments plus in-flight style previews', async () => {
    const a = makePage({ id: 'a', rootNodeId: 'root-a', nodes: { 'root-a': makeNode({ id: 'root-a', moduleId: 'base.body', classIds: ['alpha'] }) } })
    const b = makePage({ id: 'b', rootNodeId: 'root-b', nodes: { 'root-b': makeNode({ id: 'root-b', moduleId: 'base.body', classIds: ['beta'] }) } })
    const site = makeSite({ pages: [a, b], styleRules: { alpha: rule('alpha'), beta: rule('beta'), fresh: rule('fresh') } })
    useEditorStore.setState({ site, activePageId: 'a' })
    render(<ClassStyleInjector targetDocument={document} />)
    await waitFor(() => {
      expect(css()).toContain('.alpha {')
      expect(css()).not.toContain('.beta {')
      expect(css()).not.toContain('.fresh {')
    })
    await act(async () => { useEditorStore.getState().setActivePage('b') })
    await waitFor(() => {
      expect(css()).toContain('.beta {')
      expect(css()).not.toContain('.alpha {')
    })
    await act(async () => { useEditorStore.getState().setPreviewNodeClass('root-b', 'fresh') })
    await waitFor(() => { expect(css()).toContain('.fresh {') })
    expect(useEditorStore.getState().site!.pages[1].nodes['root-b'].classIds).toEqual(['beta'])
    await act(async () => { useEditorStore.getState().clearPreviewNodeClass() })
    await waitFor(() => { expect(css()).not.toContain('.fresh {') })
    await act(async () => { useEditorStore.getState().addNodeClass('root-b', 'fresh') })
    await waitFor(() => { expect(css()).toContain('.fresh {') })
    await act(async () => {
      useEditorStore.setState({ previewClassStyles: { classId: 'fresh', styles: { color: 'red' }, breakpointId: null } })
    })
    await waitFor(() => {
      expect(css('mc-classes-preview')).toContain('.fresh.fresh')
      expect(css('mc-classes-preview')).toContain('color: red')
    })
    const allSiteUsage = collectUsedStyleRuleIds(useEditorStore.getState().site!)
    expect(allSiteUsage.has('alpha')).toBe(true)
    expect(allSiteUsage.has('beta')).toBe(true)
  })

  it('excludes stale previews on other pages, detached nodes and hidden subtrees', async () => {
    const a = makePage({ id: 'a', rootNodeId: 'root-a', nodes: {
      'root-a': makeNode({ id: 'root-a', children: ['hidden'], moduleId: 'base.body' }),
      hidden: makeNode({ id: 'hidden', parentId: 'root-a', hidden: true, children: ['child'] }),
      child: makeNode({ id: 'child', parentId: 'hidden' }),
      detached: makeNode({ id: 'detached' }),
    } })
    const b = makePage({ id: 'b', rootNodeId: 'root-b', nodes: { 'root-b': makeNode({ id: 'root-b', moduleId: 'base.body' }) } })
    useEditorStore.setState({ site: makeSite({ pages: [a, b], styleRules: { fresh: rule('fresh') } }), activePageId: 'a' })
    render(<ClassStyleInjector targetDocument={document} />)
    for (const nodeId of ['root-b', 'detached', 'hidden', 'child']) {
      await act(async () => { useEditorStore.getState().setPreviewNodeClass(nodeId, 'fresh') })
      expect(css()).not.toContain('.fresh {')
    }
    await act(async () => { useEditorStore.getState().setPreviewNodeClass('root-a', 'fresh') })
    await waitFor(() => { expect(css()).toContain('.fresh {') })
  })

  it('uses the active VC virtual page and reachable nested refs/slot fills, leaving other pages and VCs out', async () => {
    const nested: VisualComponent = {
      id: 'nested', name: 'Nested', params: [], classIds: ['nested-component'], createdAt: 0,
      tree: { rootNodeId: 'root', nodes: { root: makeNode({ id: 'root', moduleId: 'base.container', children: ['slot'], classIds: ['nested-node'] }), slot: makeNode({ id: 'slot', moduleId: 'base.slot-outlet', props: { slotName: 'content' } }) } },
    }
    const active: VisualComponent = {
      id: 'active', name: 'Active', params: [], classIds: ['active-component'], createdAt: 0,
      tree: { rootNodeId: 'root', nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.container', children: ['ref'], classIds: ['active-node'] }),
        ref: makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: { componentId: 'nested' }, children: ['slot-fill'] }),
        'slot-fill': makeNode({ id: 'slot-fill', moduleId: 'base.slot-instance', props: { slotName: 'content' }, children: ['filled'] }),
        filled: makeNode({ id: 'filled', moduleId: 'base.text', classIds: ['slot-content'] }),
      } },
    }
    const unused: VisualComponent = { id: 'unused', name: 'Unused', params: [], classIds: ['unused'], createdAt: 0, tree: { rootNodeId: 'root', nodes: { root: makeNode({ id: 'root', moduleId: 'base.text', classIds: ['unused'] }) } } }
    const names = ['active-component', 'active-node', 'nested-component', 'nested-node', 'slot-content', 'unused', 'other-page']
    const site = makeSite({ visualComponents: [active, nested, unused], styleRules: Object.fromEntries(names.map((id) => [id, rule(id)])) })
    site.pages[0].nodes.root.classIds = ['other-page']
    useEditorStore.setState({ site, activePageId: site.pages[0].id, activeDocument: { kind: 'visualComponent', vcId: 'active' } })
    render(<ClassStyleInjector targetDocument={document} />)
    await waitFor(() => {
      for (const id of names.slice(0, 5)) expect(css()).toContain(`.${id} {`)
      expect(css()).not.toContain('.unused {')
      expect(css()).not.toContain('.other-page {')
    })
    const state = useEditorStore.getState()
    const virtualPage = selectActiveCanvasPage(state)!
    expect(virtualPage.id).toBe('vc-virtual:active')
    expect([...collectPageStyleRuleIds(state.site!, virtualPage)].sort()).toEqual(names.slice(0, 5).sort())
  })

  it('keeps only enabled scoped canvas scripts and their imported helper classes while Run scripts is active', async () => {
    const a = makePage({ id: 'a' })
    const b = makePage({ id: 'b' })
    const sources = {
      global: "document.body.classList.add('global-state')",
      scoped: "import './helper.js'; document.body.classList.add('a-state')",
      helper: "document.body.classList.add('helper-state', 'hover:block', 'gruppo/voce', 'aperto-à')",
      disabled: "document.body.classList.add('disabled-state')",
      publishOnly: "document.body.classList.add('publish-state')",
      other: "document.body.classList.add('b-state')",
    }
    const names = ['global-state', 'a-state', 'helper-state', 'hover:block', 'gruppo/voce', 'aperto-à', 'disabled-state', 'publish-state', 'b-state']
    const site = makeSite({ pages: [a, b], styleRules: Object.fromEntries(names.map((id) => [id, rule(id, `.${id.replace(':', '\\:').replace('/', '\\/')}`)])), files: Object.entries(sources).map(([id, content]) => ({ id, path: `src/scripts/${id}.js`, type: 'script' as const, content, createdAt: 0, updatedAt: 0 })) })
    site.runtime!.scripts = {
      scoped: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, scope: { type: 'pages', pageIds: ['a'] } },
      helper: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, enabled: false },
      disabled: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, enabled: false },
      publishOnly: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, runInCanvas: false },
      other: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, scope: { type: 'pages', pageIds: ['b'] } },
    }
    useEditorStore.setState({ site, activePageId: 'a' })
    render(<ClassStyleInjector targetDocument={document} />)
    expect(css()).not.toContain('.global-state {')
    await act(async () => { useEditorStore.getState().setRunScripts(true) })
    await waitFor(() => {
      for (const id of names.slice(0, 6)) expect(css()).toContain(site.styleRules![id].selector)
      for (const id of names.slice(6)) expect(css()).not.toContain(site.styleRules![id].selector)
    })
    await act(async () => { useEditorStore.getState().setActivePage('b') })
    await waitFor(() => {
      expect(css()).toContain('.global-state {')
      expect(css()).toContain('.b-state {')
      expect(css()).not.toContain('.a-state {')
      expect(css()).not.toContain('.helper-state {')
    })
    await act(async () => { useEditorStore.getState().setRunScripts(false) })
    await waitFor(() => { expect(css()).not.toContain('.global-state {'); expect(css()).not.toContain('.b-state {') })
  })

  it('retains conservative ambient/function rules and does not subscribe to unrelated page edits', async () => {
    const a = makePage({ id: 'a', nodes: { root: makeNode({ id: 'root', moduleId: 'base.body', classIds: ['card'] }) } })
    const b = makePage({ id: 'b' })
    const site = makeSite({ pages: [a, b], styleRules: {
      card: rule('card', '.card:not(.closed)'), closed: rule('closed'),
      body: { ...rule('body', 'body'), kind: 'ambient' },
      unused: { ...rule('unused', '.closed .card'), kind: 'ambient' },
    } })
    useEditorStore.setState({ site, activePageId: 'a' })
    const select = createCanvasStyleRuleIdSelector()
    const first = select(useEditorStore.getState())
    render(<ClassStyleInjector targetDocument={document} />)
    await waitFor(() => {
      expect(css()).toContain('.card:not(.closed)')
      expect(css()).toContain('body {')
      expect(css()).not.toContain('.closed .card')
    })
    await act(async () => { useEditorStore.setState({ selectedNodeId: 'root' }) })
    expect(select(useEditorStore.getState())).toBe(first)
    const updated = structuredClone(useEditorStore.getState().site!)
    updated.pages[1].nodes.root.classIds = ['closed']
    await act(async () => { useEditorStore.setState({ site: updated }) })
    expect(select(useEditorStore.getState())).toBe(first)
    expect(css()).not.toContain('.closed .card')
  })
})
