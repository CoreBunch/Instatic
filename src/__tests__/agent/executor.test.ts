/**
 * Browser-side executor tests.
 *
 * The executor receives `toolRequest` stream events from the server and
 * applies the corresponding mutation against the live editor store.
 * Each tool call is its own atomic mutation — no batch semantics, no
 * cross-call refs (Claude uses real returned IDs in subsequent tool calls).
 *
 * Constraint #272 — every input is validated with TypeBox before dispatch.
 * Constraint #299 — richtext props are sanitized via DOMPurify before storage.
 */

import { describe, it, expect } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { executeAgentTool } from '@site/agent'
import type { AiToolOutput } from '@core/ai'
import { classNamesForClassIds } from '@core/page-tree'
import '@modules/base'

// ---------------------------------------------------------------------------
// Store reset helper
// ---------------------------------------------------------------------------

function freshStore() {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeClassId: null,
    isAgentOpen: false,
    isAgentStreaming: false,
    agentMessages: [],
    agentError: null,
    hasUnsavedChanges: false,
  })
  const s = useEditorStore.getState()
  const site = s.createSite('Test')
  const rootId = site.pages[0].rootNodeId
  return { rootId, store: useEditorStore.getState() }
}

function expectToolOk(result: AiToolOutput): void {
  expect(result.ok).toBe(true)
  expect(result.error).toBeUndefined()
}

function expectToolError(result: AiToolOutput): void {
  expect(result.ok).toBe(false)
  expect(result.error).toBeTruthy()
}

function expectToolData<T extends Record<string, unknown>>(result: AiToolOutput): T {
  expectToolOk(result)
  expect(result.data && typeof result.data === 'object').toBe(true)
  return result.data as T
}

function expectNodeIds(result: AiToolOutput): string[] {
  return expectToolData<{ nodeIds: string[] }>(result).nodeIds
}

function expectNodeId(result: AiToolOutput): string {
  return expectToolData<{ nodeId: string }>(result).nodeId
}

function expectPageId(result: AiToolOutput): string {
  return expectToolData<{ pageId: string }>(result).pageId
}

function expectHtml(result: AiToolOutput): string {
  return expectToolData<{ html: string }>(result).html
}

function expectHash(result: AiToolOutput): string {
  return expectToolData<{ hash: string }>(result).hash
}

function activePage() {
  const state = useEditorStore.getState()
  return state.site!.pages.find((p) => p.id === state.activePageId)!
}

async function makeTemplateDocument(): Promise<{ homeId: string; templateId: string }> {
  const { rootId } = freshStore()
  const homeId = useEditorStore.getState().activePageId!
  await executeAgentTool('insertHtml', { parentId: rootId, html: '<main><h1>Home</h1></main>' })
  const templateId = expectPageId(await executeAgentTool('addPage', {
    title: 'Main Layout',
    slug: 'main-layout',
  }))
  await executeAgentTool('setPageTemplate', {
    pageId: templateId,
    target: { kind: 'everywhere' },
    priority: 100,
  })
  const templateRootId = activePage().rootNodeId
  await executeAgentTool('insertHtml', {
    parentId: templateRootId,
    html: '<nav><button>LGT</button><button>DRK</button></nav><instatic-outlet></instatic-outlet>',
  })
  useEditorStore.getState().openPageInCanvas(homeId)
  return { homeId, templateId }
}

// ---------------------------------------------------------------------------
// insertHtml
// ---------------------------------------------------------------------------

describe('executeAgentTool — insertHtml', () => {
  it('inserts a section with heading and paragraph as a real subtree', async () => {
    const { rootId } = freshStore()
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<section class="hero"><h1>Hi</h1><p>Yo</p></section>',
    })
    const { nodeIds } = expectToolData<{ nodeIds: string[] }>(result)
    expect(nodeIds.length).toBeGreaterThan(0)

    const page = useEditorStore.getState().site!.pages[0]
    const nodes = Object.values(page.nodes)

    // The section element maps to base.container
    expect(nodes.some((n) => n.moduleId === 'base.container')).toBe(true)
    // The h1 and p elements map to base.text
    expect(nodes.some((n) => n.moduleId === 'base.text')).toBe(true)

    // The inserted root (section) is wired as a child of the page root
    const root = page.nodes[rootId]
    expect(root.children).toContain(nodeIds[0])

    // The section node has two children (h1 + p)
    const sectionNode = page.nodes[nodeIds[0]]
    expect(sectionNode.children).toHaveLength(2)
  })

  it('a <style> block class is created in the store with its styles and bound to the node', async () => {
    const { rootId } = freshStore()
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html:
        '<style>.hero-section { padding-top: 80px; background-color: tomato; }</style>' +
        '<section class="hero-section"><h1>Title</h1></section>',
    })
    const nodeIds = expectNodeIds(result)

    // The class must be created in the store from the <style> rule
    const classes = Object.values(useEditorStore.getState().site!.styleRules)
    const heroClass = classes.find((c) => c.name === 'hero-section')
    expect(heroClass).toBeDefined()
    expect(heroClass!.styles.paddingTop).toBe('80px')
    expect(heroClass!.styles.backgroundColor).toBe('tomato')

    // ...AND the imported node must reference the class by its registry id, so
    // the declared styles actually resolve at render time (regression guard:
    // the importer stamps class *names* onto classIds; insertImportedNodes
    // links them to ids — without that, styles silently never apply).
    const site = useEditorStore.getState().site!
    const sectionNode = site.pages[0].nodes[nodeIds[0]]
    expect(sectionNode.classIds).toContain(heroClass!.id)
    expect(sectionNode.classIds).not.toContain('hero-section')
    expect(classNamesForClassIds(site.styleRules, sectionNode.classIds)).toContain('hero-section')
  })

  it('a descendant selector in a <style> block becomes an ambient rule (not a malformed class)', async () => {
    const { rootId } = freshStore()
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html:
        '<style>.hero-nav a { color: tomato; }</style>' +
        '<nav class="hero-nav"><a href="/">Home</a></nav>',
    })
    expectNodeIds(result)

    const site = useEditorStore.getState().site!
    // The whitespace selector must NOT have been forced through createClass
    // (which rejects whitespace) — it round-trips as an ambient rule instead.
    const ambient = Object.values(site.styleRules).find(
      (c) => c.kind === 'ambient' && c.selector === '.hero-nav a',
    )
    expect(ambient).toBeDefined()
    expect(ambient!.styles.color).toBe('tomato')
  })

  it('bare class= attribute (no <style> declaration) auto-creates a registry class and links it', async () => {
    const { rootId } = freshStore()
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<div class="card"><p class="card-body">Hi</p></div>',
    })
    const nodeIds = expectNodeIds(result)

    const site = useEditorStore.getState().site!
    const cardClass = Object.values(site.styleRules).find((c) => c.name === 'card')
    const bodyClass = Object.values(site.styleRules).find((c) => c.name === 'card-body')
    expect(cardClass).toBeDefined()
    expect(bodyClass).toBeDefined()

    const cardNode = site.pages[0].nodes[nodeIds[0]]
    expect(cardNode.classIds).toEqual([cardClass!.id])
    // The class attribute resolves back to the original name for render.
    expect(classNamesForClassIds(site.styleRules, cardNode.classIds)).toEqual(['card'])
  })

  it('reuses an existing same-named class instead of duplicating it', async () => {
    const { rootId } = freshStore()
    const existing = useEditorStore.getState().createClass('hero', { color: '#fff' })

    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<section class="hero"></section><div class="hero"></div>',
    })
    const nodeIds = expectNodeIds(result)

    const site = useEditorStore.getState().site!
    const heroClasses = Object.values(site.styleRules).filter((c) => c.name === 'hero')
    expect(heroClasses).toHaveLength(1)
    for (const id of nodeIds) {
      expect(site.pages[0].nodes[id].classIds).toEqual([existing.id])
    }
  })

  it('a <style> @media block folds into the class contextStyles for the matching breakpoint', async () => {
    const { rootId } = freshStore()
    // The default site's `mobile` breakpoint is `(max-width: 375px)`, so a
    // matching @media query folds into contextStyles.mobile.
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html:
        '<style>' +
        '.hero-title { font-size: 56px; }' +
        '@media (max-width: 375px) { .hero-title { font-size: 32px; } }' +
        '</style>' +
        '<h1 class="hero-title">Hello</h1>',
    })
    expectNodeIds(result)
    const cls = Object.values(useEditorStore.getState().site!.styleRules).find(
      (c) => c.name === 'hero-title',
    )
    expect(cls).toBeDefined()
    expect(cls!.styles.fontSize).toBe('56px')
    expect(cls!.contextStyles.mobile.fontSize).toBe('32px')
  })

  it('returns failure for missing html (schema validation)', async () => {
    const { rootId } = freshStore()
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '',
    })
    expectToolError(result)
    expect(result.error).toBeTruthy()
  })

  it('returns failure when parentId does not exist', async () => {
    freshStore()
    const result = await executeAgentTool('insertHtml', {
      parentId: 'nonexistent-node',
      html: '<p>Test</p>',
    })
    expectToolError(result)
    expect(result.error).toContain('not found')
  })

  it('appends at a given index position', async () => {
    const { rootId } = freshStore()
    // Insert two nodes first
    await executeAgentTool('insertHtml', { parentId: rootId, html: '<p>First</p>' })
    await executeAgentTool('insertHtml', { parentId: rootId, html: '<p>Second</p>' })

    // Now insert a third at index 0 (before both)
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<h1>Before</h1>',
      index: 0,
    })
    const nodeIds = expectNodeIds(result)

    const page = useEditorStore.getState().site!.pages[0]
    const root = page.nodes[rootId]
    // The newly inserted node is at position 0
    expect(root.children[0]).toBe(nodeIds[0])
    expect(root.children).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// style-only payloads (ambient/pseudo CSS without an element to host it)
// ---------------------------------------------------------------------------

describe('executeAgentTool — style-only payloads', () => {
  it('insertHtml registers an ambient rule from a <style>-only payload (no nodes added)', async () => {
    const { rootId } = freshStore()
    const rootChildrenBefore = useEditorStore.getState().site!.pages[0].nodes[rootId].children.length

    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<style>.hero a:hover { color: tomato; }</style>',
    })

    // Previously this returned "HTML contained no importable elements" and threw
    // the ambient CSS away. Now it succeeds and upserts the rule.
    const data = expectToolData<{ cssRulesCreated: number; cssRulesUpdated: number }>(result)
    expect(data.cssRulesCreated + data.cssRulesUpdated).toBeGreaterThan(0)

    const site = useEditorStore.getState().site!
    const ambient = Object.values(site.styleRules).find(
      (c) => c.kind === 'ambient' && c.selector === '.hero a:hover',
    )
    expect(ambient).toBeDefined()
    expect(ambient!.styles.color).toBe('tomato')

    // No element nodes were added under the parent.
    expect(site.pages[0].nodes[rootId].children).toHaveLength(rootChildrenBefore)
  })

  it('insertHtml still errors when the payload has neither elements nor rules', async () => {
    const { rootId } = freshStore()
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<style>   </style>',
    })
    expectToolError(result)
    expect(result.error).toContain('no importable elements or style rules')
  })

  it('replaceNodeHtml with a <style>-only payload registers CSS WITHOUT wiping children', async () => {
    const { rootId } = freshStore()
    const containerId = expectNodeIds(
      await executeAgentTool('insertHtml', { parentId: rootId, html: '<div></div>' }),
    )[0]
    await executeAgentTool('insertHtml', { parentId: containerId, html: '<p>Keep me</p>' })

    const childrenBefore = [...useEditorStore.getState().site!.pages[0].nodes[containerId].children]
    expect(childrenBefore).toHaveLength(1)

    const result = await executeAgentTool('replaceNodeHtml', {
      nodeId: containerId,
      html: '<style>.card::before { content: ""; }</style>',
    })

    expectToolData<{ cssRulesCreated: number; cssRulesUpdated: number }>(result)

    const site = useEditorStore.getState().site!
    // Children are untouched — a style-only "replace" must not destroy the subtree.
    expect(site.pages[0].nodes[containerId].children).toEqual(childrenBefore)
    expect(
      Object.values(site.styleRules).some((c) => c.selector === '.card::before'),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// code assets
// ---------------------------------------------------------------------------

describe('executeAgentTool — code assets', () => {
  it('write_code_asset creates a runtime script with config and list/read expose it', async () => {
    freshStore()
    const result = await executeAgentTool('write_code_asset', {
      path: 'src/scripts/theme-toggle.js',
      type: 'script',
      content: 'document.documentElement.dataset.theme = "dark"',
      runtime: {
        format: 'classic',
        placement: 'body-end',
        timing: 'dom-ready',
        runInCanvas: true,
        scope: { type: 'all-pages' },
        priority: 20,
      },
    })
    const data = expectToolData<{ fileId: string; path: string; type: string; hash: string }>(result)
    expect(data.path).toBe('src/scripts/theme-toggle.js')
    expect(data.type).toBe('script')
    expect(data.hash).toHaveLength(64)

    const state = useEditorStore.getState()
    const file = state.site!.files.find((item) => item.id === data.fileId)!
    expect(file.content).toBe('document.documentElement.dataset.theme = "dark"')
    expect(state.siteRuntime.scripts[data.fileId]).toEqual({
      enabled: true,
      runInCanvas: true,
      format: 'classic',
      placement: 'body-end',
      timing: 'dom-ready',
      scope: { type: 'all-pages' },
      priority: 20,
    })

    const list = expectToolData<{
      assets: Array<{ fileId: string; path: string; type: string; hash: string; runtime: unknown }>
    }>(await executeAgentTool('list_code_assets', { type: 'script' }))
    expect(list.assets).toContainEqual(
      expect.objectContaining({
        fileId: data.fileId,
        path: 'src/scripts/theme-toggle.js',
        type: 'script',
        hash: data.hash,
        runtime: expect.objectContaining({ format: 'classic', timing: 'dom-ready' }),
      }),
    )

    const read = expectToolData<{
      fileId: string
      path: string
      content: string
      hash: string
      pageInfo: { nextPart: number | null }
    }>(await executeAgentTool('read_code_asset', { fileId: data.fileId }))
    expect(read.path).toBe('src/scripts/theme-toggle.js')
    expect(read.content).toBe('document.documentElement.dataset.theme = "dark"')
    expect(read.hash).toBe(data.hash)
    expect(read.pageInfo.nextPart).toBeNull()
  })

  it('write_code_asset creates a runtime stylesheet and inspect_code_runtime shows page applicability', async () => {
    const { rootId } = freshStore()
    await executeAgentTool('insertHtml', { parentId: rootId, html: '<main><h1>Home</h1></main>' })
    const style = expectToolData<{ fileId: string }>(await executeAgentTool('write_code_asset', {
      path: 'src/styles/theme.css',
      type: 'style',
      content: ':root { color-scheme: light dark; }',
      runtime: {
        enabled: true,
        scope: { type: 'all-pages' },
        priority: 5,
      },
    }))

    const runtime = expectToolData<{
      styles: Array<{ fileId: string; path: string; applies: boolean; priority: number }>
      scripts: unknown[]
    }>(await executeAgentTool('inspect_code_runtime', {}))
    expect(runtime.styles).toContainEqual(
      expect.objectContaining({
        fileId: style.fileId,
        path: 'src/styles/theme.css',
        applies: true,
        priority: 5,
      }),
    )
    expect(runtime.scripts).toEqual([])
  })

  it('read_code_asset pages long file content and preserves a stable full hash', async () => {
    freshStore()
    const content = Array.from({ length: 120 }, (_, i) => `line-${i}`).join('\n')
    const write = await executeAgentTool('write_code_asset', {
      path: 'src/scripts/long.js',
      type: 'script',
      content,
    })
    const hash = expectHash(write)

    const first = expectToolData<{
      content: string
      hash: string
      pageInfo: { part: number; nextPart: number | null; totalParts: number }
    }>(await executeAgentTool('read_code_asset', { path: 'src/scripts/long.js', maxChars: 80 }))
    expect(first.hash).toBe(hash)
    expect(first.pageInfo.part).toBe(1)
    expect(first.pageInfo.nextPart).toBe(2)
    expect(first.pageInfo.totalParts).toBeGreaterThan(1)
    expect(first.content.length).toBeLessThanOrEqual(80)

    const second = expectToolData<{
      content: string
      hash: string
      pageInfo: { part: number }
    }>(await executeAgentTool('read_code_asset', {
      path: 'src/scripts/long.js',
      part: 2,
      maxChars: 80,
    }))
    expect(second.hash).toBe(hash)
    expect(second.pageInfo.part).toBe(2)
    expect(second.content).not.toBe(first.content)
  })

  it('patch_code_asset requires an expected hash and applies exact replacements safely', async () => {
    freshStore()
    const write = await executeAgentTool('write_code_asset', {
      path: 'src/scripts/theme-toggle.js',
      type: 'script',
      content: 'const initial = "light";\nconst next = "dark";\n',
    })
    const oldHash = expectHash(write)

    const stale = await executeAgentTool('patch_code_asset', {
      path: 'src/scripts/theme-toggle.js',
      expectedHash: 'not-the-current-hash',
      replacements: [{ oldText: 'light', newText: 'dark' }],
    })
    expectToolError(stale)
    expect(stale.error).toContain('hash')

    const patched = expectToolData<{ hash: string; replacements: number }>(
      await executeAgentTool('patch_code_asset', {
        path: 'src/scripts/theme-toggle.js',
        expectedHash: oldHash,
        replacements: [{ oldText: 'const initial = "light";', newText: 'const initial = "dark";' }],
      }),
    )
    expect(patched.replacements).toBe(1)
    expect(patched.hash).not.toBe(oldHash)

    const read = expectToolData<{ content: string; hash: string }>(
      await executeAgentTool('read_code_asset', { path: 'src/scripts/theme-toggle.js' }),
    )
    expect(read.content).toContain('const initial = "dark";')
    expect(read.content).toContain('const next = "dark";')
    expect(read.hash).toBe(patched.hash)
  })

  it('patch_code_asset rejects ambiguous replacements unless replaceAll is explicit', async () => {
    freshStore()
    const write = await executeAgentTool('write_code_asset', {
      path: 'src/scripts/repeated.js',
      type: 'script',
      content: 'theme = "light";\ntheme = "light";\n',
    })
    const oldHash = expectHash(write)

    const ambiguous = await executeAgentTool('patch_code_asset', {
      path: 'src/scripts/repeated.js',
      expectedHash: oldHash,
      replacements: [{ oldText: 'light', newText: 'dark' }],
    })
    expectToolError(ambiguous)
    expect(ambiguous.error).toContain('ambiguous')

    const patched = expectToolData<{ replacements: number }>(await executeAgentTool('patch_code_asset', {
      path: 'src/scripts/repeated.js',
      expectedHash: oldHash,
      replacements: [{ oldText: 'light', newText: 'dark', replaceAll: true }],
    }))
    expect(patched.replacements).toBe(2)
    const read = expectToolData<{ content: string }>(
      await executeAgentTool('read_code_asset', { path: 'src/scripts/repeated.js' }),
    )
    expect(read.content).toBe('theme = "dark";\ntheme = "dark";\n')
  })
})

// ---------------------------------------------------------------------------
// getNodeHtml
// ---------------------------------------------------------------------------

describe('executeAgentTool — getNodeHtml', () => {
  it('returns the rendered HTML for an existing node subtree', async () => {
    const { rootId } = freshStore()

    // Insert a heading so there is something to read back
    const insertResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<h1>Hello World</h1>',
    })
    const nodeId = expectNodeIds(insertResult)[0]

    const result = await executeAgentTool('getNodeHtml', { nodeId })
    const html = expectHtml(result)
    expect(html).toBeTruthy()
    // The rendered output must contain the heading text
    expect(html).toContain('Hello World')
    // And the h1 tag
    expect(html).toMatch(/<h1[^>]*>/)
  })

  it('returns html for a container node with children', async () => {
    const { rootId } = freshStore()

    const insertResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<section><h2>Title</h2><p>Body</p></section>',
    })
    const sectionId = expectNodeIds(insertResult)[0]

    const result = await executeAgentTool('getNodeHtml', { nodeId: sectionId })
    const html = expectHtml(result)
    expect(html).toBeTruthy()
    // The section renders its children too
    expect(html).toContain('Title')
    expect(html).toContain('Body')
  })

  it('returns failure when nodeId does not exist', async () => {
    freshStore()
    const result = await executeAgentTool('getNodeHtml', { nodeId: 'nonexistent-node' })
    expectToolError(result)
    expect(result.error).toContain('not found')
  })

  it('returns failure for empty nodeId (schema validation)', async () => {
    freshStore()
    const result = await executeAgentTool('getNodeHtml', { nodeId: '' })
    expectToolError(result)
    expect(result.error).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// replaceNodeHtml
// ---------------------------------------------------------------------------

describe('executeAgentTool — replaceNodeHtml', () => {
  it('preserves the target container node and rebuilds its children from new HTML', async () => {
    const { rootId } = freshStore()

    // Insert a container with one child
    const containerResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<div></div>',
    })
    const containerId = expectNodeIds(containerResult)[0]
    await executeAgentTool('insertHtml', { parentId: containerId, html: '<p>Old content</p>' })

    const pageBefore = useEditorStore.getState().site!.pages[0]
    expect(pageBefore.nodes[containerId].children).toHaveLength(1)

    // Replace children with two new elements
    const result = await executeAgentTool('replaceNodeHtml', {
      nodeId: containerId,
      html: '<h1>New Heading</h1><p>New paragraph</p>',
    })

    expectNodeIds(result)

    const pageAfter = useEditorStore.getState().site!.pages[0]
    // The container node is preserved as the parent
    expect(pageAfter.nodes[containerId]).toBeDefined()
    expect(pageAfter.nodes[containerId].moduleId).toBe('base.container')

    // Children are rebuilt from the new HTML (h1 + p = 2 nodes)
    expect(pageAfter.nodes[containerId].children).toHaveLength(2)

    // Both new children are base.text (h1 and p both map to base.text)
    const childNodes = pageAfter.nodes[containerId].children.map(
      (id) => pageAfter.nodes[id],
    )
    expect(childNodes.every((n) => n.moduleId === 'base.text')).toBe(true)
  })

  it('returns failure when nodeId does not exist', async () => {
    freshStore()
    const result = await executeAgentTool('replaceNodeHtml', {
      nodeId: 'nonexistent',
      html: '<p>Test</p>',
    })
    expectToolError(result)
    expect(result.error).toContain('not found')
  })

  it('returns failure for empty html (schema validation)', async () => {
    const { rootId } = freshStore()
    const containerResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<div></div>',
    })
    const containerId = expectNodeIds(containerResult)[0]
    const result = await executeAgentTool('replaceNodeHtml', {
      nodeId: containerId,
      html: '',
    })
    expectToolError(result)
    expect(result.error).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// auto-navigation to the node's owning document
// ---------------------------------------------------------------------------

describe('executeAgentTool — auto-navigates to the target node\'s document', () => {
  // Create a node in page A, then switch the active page to a fresh page B so
  // the node now lives in a NON-active document. Returns the node id + page A id.
  async function foreignNode(html: string): Promise<{ id: string; pageAId: string }> {
    const { rootId } = freshStore()
    const id = expectNodeIds(
      await executeAgentTool('insertHtml', { parentId: rootId, html }),
    )[0]
    const pageAId = useEditorStore.getState().activePageId!
    // addPage makes the new page active → id is now in a non-active document.
    await executeAgentTool('addPage', { title: 'Other', slug: 'other' })
    return { id, pageAId }
  }

  it('replaceNodeHtml switches to the owning page and applies the edit there', async () => {
    const { id, pageAId } = await foreignNode('<div></div>')
    expect(useEditorStore.getState().activePageId).not.toBe(pageAId)

    const result = await executeAgentTool('replaceNodeHtml', { nodeId: id, html: '<p>Hi A</p>' })
    expectNodeIds(result)

    // The canvas navigated to page A (the owner)…
    expect(useEditorStore.getState().activePageId).toBe(pageAId)
    // …and the edit landed in page A's tree.
    const pageA = useEditorStore.getState().site!.pages.find((p) => p.id === pageAId)!
    expect(pageA.nodes[id].children).toHaveLength(1)
  })

  it('insertHtml under a parent in another page navigates to that page', async () => {
    const { id, pageAId } = await foreignNode('<div></div>')
    const result = await executeAgentTool('insertHtml', { parentId: id, html: '<p>child</p>' })
    expectNodeIds(result)
    expect(useEditorStore.getState().activePageId).toBe(pageAId)
  })

  it('getNodeHtml navigates to the owning page and returns its HTML', async () => {
    const { id, pageAId } = await foreignNode('<p>Hello</p>')
    const result = await executeAgentTool('getNodeHtml', { nodeId: id })
    expectToolOk(result)
    expect(expectHtml(result)).toContain('Hello')
    expect(useEditorStore.getState().activePageId).toBe(pageAId)
  })

  it('getNodeHtml navigates to the owning visual component and returns its HTML', async () => {
    freshStore()
    const pageId = useEditorStore.getState().activePageId!
    const vcId = useEditorStore.getState().createVisualComponent('Promo Card')
    const vc = useEditorStore.getState().site!.visualComponents.find((item) => item.id === vcId)!
    useEditorStore.getState().setActiveDocument({ kind: 'visualComponent', vcId })
    const nodeId = expectNodeIds(
      await executeAgentTool('insertHtml', {
        parentId: vc.tree.rootNodeId,
        html: '<h2>Component title</h2>',
      }),
    )[0]
    useEditorStore.getState().openPageInCanvas(pageId)

    const result = await executeAgentTool('getNodeHtml', { nodeId })

    expectToolOk(result)
    expect(expectHtml(result)).toContain('Component title')
    expect(useEditorStore.getState().activeDocument).toEqual({ kind: 'visualComponent', vcId })
  })

  it('updateNodeProps navigates to the owning page', async () => {
    const { id, pageAId } = await foreignNode('<p>Old</p>')
    const result = await executeAgentTool('updateNodeProps', { nodeId: id, patch: { text: 'New' } })
    expectToolOk(result)
    expect(useEditorStore.getState().activePageId).toBe(pageAId)
  })

  it('still errors clearly when the node exists nowhere', async () => {
    freshStore()
    const result = await executeAgentTool('replaceNodeHtml', {
      nodeId: 'does-not-exist',
      html: '<p>x</p>',
    })
    expectToolError(result)
    expect(result.error).toContain('not found')
  })

  it('explains when a document id is passed where a node id is required', async () => {
    const { templateId } = await makeTemplateDocument()
    const result = await executeAgentTool('getNodeHtml', { nodeId: templateId })
    expectToolError(result)
    expect(result.error).toContain('document id')
    expect(result.error).toContain('read_document')
    expect(result.error).toContain('uid')
  })
})

// ---------------------------------------------------------------------------
// document-aware read and open tools
// ---------------------------------------------------------------------------

describe('executeAgentTool — document targeting', () => {
  it('read_document reads a non-active template without switching the visible page', async () => {
    const { homeId, templateId } = await makeTemplateDocument()
    expect(useEditorStore.getState().activePageId).toBe(homeId)

    const result = await executeAgentTool('read_document', {
      document: { type: 'template', id: templateId },
    })
    const data = expectToolData<{
      html: string
      css: string
      pageInfo: { part: number; totalParts: number; nextPart: number | null }
      document: { type: string; id: string }
    }>(result)

    expect(data.document).toEqual({ type: 'template', id: templateId })
    expect(data.html).toContain('uid=')
    expect(data.html).toContain('LGT')
    expect(data.html).toContain('DRK')
    expect(data.pageInfo).toEqual(expect.objectContaining({
      part: 1,
      totalParts: 1,
      nextPart: null,
    }))
    expect(useEditorStore.getState().activePageId).toBe(homeId)
  })

  it('read_document with no document reads the current active page', async () => {
    const { rootId } = freshStore()
    await executeAgentTool('insertHtml', { parentId: rootId, html: '<h1>Current page</h1>' })

    const result = await executeAgentTool('read_document', {})
    const data = expectToolData<{ html: string; document: { type: string; id: string } }>(result)

    expect(data.document).toEqual({ type: 'page', id: useEditorStore.getState().activePageId })
    expect(data.html).toContain('Current page')
  })

  it('open_document switches visibly to a page or template', async () => {
    const { templateId } = await makeTemplateDocument()

    const result = await executeAgentTool('open_document', {
      document: { type: 'template', id: templateId },
    })
    expectToolOk(result)
    expect(useEditorStore.getState().activePageId).toBe(templateId)
    expect(useEditorStore.getState().activeDocument).toBeNull()
  })

  it('open_document switches visibly to a visual component', async () => {
    freshStore()
    const vcId = useEditorStore.getState().createVisualComponent('Card')

    const result = await executeAgentTool('open_document', {
      document: { type: 'visualComponent', id: vcId },
    })

    expectToolOk(result)
    expect(useEditorStore.getState().activeDocument).toEqual({ kind: 'visualComponent', vcId })
  })
})

// ---------------------------------------------------------------------------
// deleteNode
// ---------------------------------------------------------------------------

describe('executeAgentTool — deleteNode', () => {
  it('deletes a node successfully', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<p></p>',
    })
    const nodeId = expectNodeIds(insertResult)[0]

    const deleteResult = await executeAgentTool('deleteNode', { nodeId })
    expectToolOk(deleteResult)

    const page = useEditorStore.getState().site!.pages[0]
    expect(page.nodes[nodeId]).toBeUndefined()
  })

  it('fails with empty nodeId', async () => {
    freshStore()
    const result = await executeAgentTool('deleteNode', { nodeId: '' })
    expectToolError(result)
  })
})

// ---------------------------------------------------------------------------
// updateNodeProps
// ---------------------------------------------------------------------------

describe('executeAgentTool — updateNodeProps', () => {
  it('patches node props', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<p>Old</p>',
    })
    const nodeId = expectNodeIds(insertResult)[0]
    await executeAgentTool('updateNodeProps', { nodeId, patch: { text: 'New' } })
    const page = useEditorStore.getState().site!.pages[0]
    expect(page.nodes[nodeId].props.text).toBe('New')
  })

  it('rejects updateNodeProps with breakpointId for content props', async () => {
    // Module props are content (single value across all breakpoints) because
    // the published page is one HTML document. Per-breakpoint visual
    // variation lives in class breakpoint styles, not in module props. The
    // executor must reject the call with a clear error so the agent doesn't
    // silently produce data that the canvas/publisher will discard at read
    // time anyway.
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<p>Desktop copy</p>',
    })
    const nodeId = expectNodeIds(insertResult)[0]

    const result = await executeAgentTool('updateNodeProps', {
      nodeId,
      breakpointId: 'mobile',
      patch: { text: 'Mobile copy' },
    })

    expectToolError(result)
    expect(result.error ?? '').toContain('breakpointOverridable')
    const page = useEditorStore.getState().site!.pages[0]
    expect(page.nodes[nodeId].props.text).toBe('Desktop copy')
    expect(page.nodes[nodeId].breakpointOverrides.mobile).toBeUndefined()
  })

  it('rejects updateNodeProps targeting an unknown breakpoint', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<p></p>',
    })
    const nodeId = expectNodeIds(insertResult)[0]

    const result = await executeAgentTool('updateNodeProps', {
      nodeId,
      breakpointId: 'watch',
      patch: { text: 'Smaller' },
    })

    expectToolError(result)
    expect(result.error).toContain('Breakpoint not found')
  })
})

// ---------------------------------------------------------------------------
// moveNode
// ---------------------------------------------------------------------------

describe('executeAgentTool — moveNode', () => {
  it('moves a node to a new parent', async () => {
    const { rootId } = freshStore()
    const c1 = expectNodeIds(await executeAgentTool('insertHtml', { parentId: rootId, html: '<div></div>' }))[0]
    const c2 = expectNodeIds(await executeAgentTool('insertHtml', { parentId: rootId, html: '<div></div>' }))[0]
    const child = expectNodeIds(await executeAgentTool('insertHtml', { parentId: c1, html: '<p></p>' }))[0]
    const result = await executeAgentTool('moveNode', { nodeId: child, newParentId: c2, newIndex: 0 })
    expectToolOk(result)
    const page = useEditorStore.getState().site!.pages[0]
    expect(page.nodes[c2].children).toContain(child)
    expect(page.nodes[c1].children).not.toContain(child)
  })
})

// ---------------------------------------------------------------------------
// renameNode
// ---------------------------------------------------------------------------

describe('executeAgentTool — renameNode', () => {
  it('sets the node label', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', { parentId: rootId, html: '<p></p>' })
    const nodeId = expectNodeIds(insertResult)[0]
    await executeAgentTool('renameNode', { nodeId, label: 'Hero Heading' })
    const page = useEditorStore.getState().site!.pages[0]
    expect(page.nodes[nodeId].label).toBe('Hero Heading')
  })
})

// ---------------------------------------------------------------------------
// applyCss — the single CSS-authoring tool (create + edit, classes + ambient)
// ---------------------------------------------------------------------------

const findRule = (predicate: (c: { name: string; kind?: string; selector: string }) => boolean) =>
  Object.values(useEditorStore.getState().site!.styleRules).find(predicate)

describe('executeAgentTool — applyCss', () => {
  it('creates a reusable class from a bare `.foo` selector', async () => {
    freshStore()
    const result = await executeAgentTool('applyCss', {
      css: '.btn-primary { font-size: 14px; color: var(--primary); }',
    })
    const data = expectToolData<{ cssRulesCreated: number; cssRulesUpdated: number }>(result)
    expect(data.cssRulesCreated).toBe(1)
    expect(data.cssRulesUpdated).toBe(0)

    const cls = findRule((c) => c.name === 'btn-primary')!
    expect(cls.kind ?? 'class').toBe('class')
    expect(cls.styles.fontSize).toBe('14px')
    expect(cls.styles.color).toBe('var(--primary)')
  })

  it('EDITS an existing class when its selector is re-applied (upsert, not duplicate)', async () => {
    freshStore()
    await executeAgentTool('applyCss', { css: '.card { color: red; }' })
    const result = await executeAgentTool('applyCss', {
      css: '.card { color: blue; font-size: 20px; }',
    })
    const data = expectToolData<{ cssRulesCreated: number; cssRulesUpdated: number }>(result)
    expect(data.cssRulesUpdated).toBe(1)
    expect(data.cssRulesCreated).toBe(0)

    const cards = Object.values(useEditorStore.getState().site!.styleRules).filter((c) => c.name === 'card')
    expect(cards).toHaveLength(1) // merged onto the existing rule, not duplicated
    expect(cards[0].styles.color).toBe('blue') // overwritten
    expect(cards[0].styles.fontSize).toBe('20px') // added
  })

  it('creates an ambient rule from a descendant selector', async () => {
    freshStore()
    await executeAgentTool('applyCss', { css: '.hero a { color: tomato; }' })
    const ambient = findRule((c) => c.kind === 'ambient' && c.selector === '.hero a')!
    expect(ambient).toBeDefined()
    expect(ambient.styles.color).toBe('tomato')
  })

  it('EDITS an existing ambient descendant/pseudo rule — the case updateClassStyles could not express', async () => {
    freshStore()
    await executeAgentTool('applyCss', { css: '.hero a:hover { color: red; }' })
    const result = await executeAgentTool('applyCss', {
      css: '.hero a:hover { color: var(--primary); text-decoration: underline; }',
    })
    const data = expectToolData<{ cssRulesCreated: number; cssRulesUpdated: number }>(result)
    expect(data.cssRulesUpdated).toBe(1)

    const matches = Object.values(useEditorStore.getState().site!.styleRules).filter(
      (c) => c.kind === 'ambient' && c.selector === '.hero a:hover',
    )
    expect(matches).toHaveLength(1) // upserted, not piled up as a duplicate
    expect(matches[0].styles.color).toBe('var(--primary)')
    expect(matches[0].styles.textDecoration).toBe('underline')
  })

  it('folds a matching @media block into the rule contextStyles', async () => {
    freshStore()
    await executeAgentTool('applyCss', {
      css:
        '.hero-title { font-size: 56px; }' +
        '@media (max-width: 375px) { .hero-title { font-size: 32px; } }',
    })
    const cls = findRule((c) => c.name === 'hero-title')!
    expect(cls.styles.fontSize).toBe('56px')
    expect(cls.contextStyles.mobile.fontSize).toBe('32px')
  })

  it('returns an error for CSS that parses to no rules', async () => {
    freshStore()
    const result = await executeAgentTool('applyCss', { css: '/* just a comment */' })
    expectToolError(result)
    expect(result.error).toContain('No CSS rules parsed')
  })
})

// ---------------------------------------------------------------------------
// assignClass / removeClass
// ---------------------------------------------------------------------------

describe('executeAgentTool — assignClass / removeClass', () => {
  it('assigns a class to a node', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', { parentId: rootId, html: '<p></p>' })
    const nodeId = expectNodeIds(insertResult)[0]
    const classId = useEditorStore.getState().createClass('highlighted').id

    await executeAgentTool('assignClass', { nodeId, classId })
    const page = useEditorStore.getState().site!.pages[0]
    expect(page.nodes[nodeId].classIds).toContain(classId)
  })

  it('removes a class from a node', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', { parentId: rootId, html: '<p></p>' })
    const nodeId = expectNodeIds(insertResult)[0]
    const classId = useEditorStore.getState().createClass('highlighted2').id

    await executeAgentTool('assignClass', { nodeId, classId })
    await executeAgentTool('removeClass', { nodeId, classId })
    const page = useEditorStore.getState().site!.pages[0]
    expect(page.nodes[nodeId].classIds ?? []).not.toContain(classId)
  })
})

// ---------------------------------------------------------------------------
// Class identifiers — name vs id resolution
// ---------------------------------------------------------------------------

describe('executeAgentTool — class identifier resolution', () => {
  it('resolves classId by name in assignClass', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<button>Click</button>',
    })
    const nodeId = expectNodeIds(insertResult)[0]
    await executeAgentTool('applyCss', { css: '.btn-hero { color: #fff; }' })

    const result = await executeAgentTool('assignClass', { nodeId, classId: 'btn-hero' })
    expectToolOk(result)

    const page = useEditorStore.getState().site!.pages[0]
    const classes = useEditorStore.getState().site!.styleRules
    const heroClass = Object.values(classes).find((c) => c.name === 'btn-hero')!
    expect(page.nodes[nodeId].classIds).toContain(heroClass.id)
  })

  it('returns failure when classId / name does not match any class', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<button>Click</button>',
    })
    const nodeId = expectNodeIds(insertResult)[0]
    const result = await executeAgentTool('assignClass', { nodeId, classId: 'nonexistent-class' })
    expectToolError(result)
    expect(result.error).toContain('nonexistent-class')
  })

  it('removeClass also resolves by name', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<button>Click</button>',
    })
    const nodeId = expectNodeIds(insertResult)[0]
    await executeAgentTool('applyCss', { css: '.removable { color: #fff; }' })
    await executeAgentTool('assignClass', { nodeId, classId: 'removable' })

    const result = await executeAgentTool('removeClass', { nodeId, classId: 'removable' })
    expectToolOk(result)

    const page = useEditorStore.getState().site!.pages[0]
    const classes = useEditorStore.getState().site!.styleRules
    const cls = Object.values(classes).find((c) => c.name === 'removable')!
    expect(page.nodes[nodeId].classIds ?? []).not.toContain(cls.id)
  })
})

// ---------------------------------------------------------------------------
// addPage
// ---------------------------------------------------------------------------

describe('executeAgentTool — addPage', () => {
  it('adds a page to the site', async () => {
    freshStore()
    const result = await executeAgentTool('addPage', { title: 'About', slug: 'about' })
    expect(expectPageId(result)).toBeTruthy()
    const pages = useEditorStore.getState().site!.pages
    expect(pages.some((p) => p.title === 'About')).toBe(true)
  })

  it('returns rootNodeId (the parent for insertHtml) and activates the page', async () => {
    freshStore()
    const result = await executeAgentTool('addPage', { title: 'About', slug: 'about' })
    const data = expectToolData<{ pageId: string; rootNodeId: string }>(result)
    const newPage = useEditorStore.getState().site!.pages.find((p) => p.id === data.pageId)!
    expect(data.rootNodeId).toBe(newPage.rootNodeId)
    // The returned rootNodeId is insertable because addPage makes the page active.
    const insert = await executeAgentTool('insertHtml', {
      parentId: data.rootNodeId,
      html: '<h1>Hi</h1>',
    })
    expect(insert.ok).toBe(true)
  })

  it('a second addPage with the same slug does not collide (auto-unique)', async () => {
    freshStore()
    await executeAgentTool('addPage', { title: 'Main Template', slug: 'main-template' })
    await executeAgentTool('addPage', { title: 'Main Template', slug: 'main-template' })
    const slugs = useEditorStore.getState().site!.pages.map((p) => p.slug)
    expect(new Set(slugs).size).toBe(slugs.length) // all unique → site stays save-valid
  })
})

// ---------------------------------------------------------------------------
// renamePage / deletePage / duplicatePage — page-admin
// ---------------------------------------------------------------------------

describe('executeAgentTool — renamePage', () => {
  it('renames an existing page', async () => {
    freshStore()
    const addResult = await executeAgentTool('addPage', { title: 'About', slug: 'about' })
    const pageId = expectPageId(addResult)

    const result = await executeAgentTool('renamePage', {
      pageId,
      title: 'About Us',
      slug: 'about-us',
    })
    expectToolOk(result)

    const page = useEditorStore.getState().site!.pages.find((p) => p.id === pageId)!
    expect(page.title).toBe('About Us')
    expect(page.slug).toBe('about-us')
  })

  it('fails for a missing page id', async () => {
    freshStore()
    const result = await executeAgentTool('renamePage', {
      pageId: 'nonexistent',
      title: 'Whatever',
    })
    expectToolError(result)
    expect(result.error).toContain('Page not found')
  })
})

describe('executeAgentTool — deletePage', () => {
  it('deletes a page when more than one remains', async () => {
    freshStore()
    const added = await executeAgentTool('addPage', { title: 'About', slug: 'about' })
    const pageId = expectPageId(added)

    const result = await executeAgentTool('deletePage', { pageId })
    expectToolOk(result)

    const pages = useEditorStore.getState().site!.pages
    expect(pages.some((p) => p.id === pageId)).toBe(false)
  })

  it('fails for a missing page id', async () => {
    freshStore()
    const result = await executeAgentTool('deletePage', { pageId: 'nonexistent' })
    expectToolError(result)
    expect(result.error).toContain('Page not found')
  })

  it('refuses to delete the last remaining page', async () => {
    freshStore()
    // freshStore creates one page; we did not add another, so it's the only one.
    const onlyPage = useEditorStore.getState().site!.pages[0]
    const result = await executeAgentTool('deletePage', { pageId: onlyPage.id })
    expectToolError(result)
    expect(result.error).toContain('last page')
  })
})

describe('executeAgentTool — duplicatePage', () => {
  it('deep-clones a page with all of its nodes under a new title and slug', async () => {
    const { rootId } = freshStore()
    // Add some content to the source page so the duplicate isn't trivially empty.
    await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<h1>Hero</h1>',
    })
    await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<button>Click me</button>',
    })

    const sourcePage = useEditorStore.getState().site!.pages[0]
    const sourceNodeCount = Object.keys(sourcePage.nodes).length

    const result = await executeAgentTool('duplicatePage', {
      pageId: sourcePage.id,
      title: 'Pricing',
      slug: 'pricing',
    })
    const pageId = expectPageId(result)

    const newPage = useEditorStore.getState().site!.pages.find((p) => p.id === pageId)!
    expect(newPage.title).toBe('Pricing')
    expect(newPage.slug).toBe('pricing')
    // Every source node has a fresh-id counterpart in the new page.
    expect(Object.keys(newPage.nodes)).toHaveLength(sourceNodeCount)
    // No id overlap with the source.
    const sharedIds = Object.keys(newPage.nodes).filter((id) => sourcePage.nodes[id])
    expect(sharedIds).toEqual([])
  })

  it('fails for a missing source page id', async () => {
    freshStore()
    const result = await executeAgentTool('duplicatePage', {
      pageId: 'nonexistent',
      title: 'Copy',
    })
    expectToolError(result)
    expect(result.error).toContain('Page not found')
  })
})

// ---------------------------------------------------------------------------
// setPageTemplate / clearPageTemplate
// ---------------------------------------------------------------------------

describe('executeAgentTool — setPageTemplate / clearPageTemplate', () => {
  it('converts a page into an everywhere template with the default priority', async () => {
    freshStore()
    const pageId = useEditorStore.getState().site!.pages[0].id
    const result = await executeAgentTool('setPageTemplate', {
      pageId,
      target: { kind: 'everywhere' },
    })
    expectToolOk(result)
    const page = useEditorStore.getState().site!.pages.find((p) => p.id === pageId)!
    expect(page.template).toEqual({
      enabled: true,
      target: { kind: 'everywhere' },
      priority: 100,
    })
  })

  it('converts a page into a postTypes template with the given slugs and priority', async () => {
    freshStore()
    const pageId = useEditorStore.getState().site!.pages[0].id
    const result = await executeAgentTool('setPageTemplate', {
      pageId,
      target: { kind: 'postTypes', tableSlugs: ['posts'] },
      priority: 50,
    })
    expectToolOk(result)
    const page = useEditorStore.getState().site!.pages.find((p) => p.id === pageId)!
    expect(page.template).toEqual({
      enabled: true,
      target: { kind: 'postTypes', tableSlugs: ['posts'] },
      priority: 50,
    })
  })

  it('fails for a missing page id', async () => {
    freshStore()
    const result = await executeAgentTool('setPageTemplate', {
      pageId: 'nonexistent',
      target: { kind: 'everywhere' },
    })
    expectToolError(result)
    expect(result.error).toContain('Page not found')
  })

  it('rejects a postTypes target with no slugs (schema validation)', async () => {
    freshStore()
    const pageId = useEditorStore.getState().site!.pages[0].id
    const result = await executeAgentTool('setPageTemplate', {
      pageId,
      target: { kind: 'postTypes', tableSlugs: [] },
    })
    expectToolError(result)
  })

  it('clearPageTemplate reverts a template back to an ordinary page', async () => {
    freshStore()
    const pageId = useEditorStore.getState().site!.pages[0].id
    await executeAgentTool('setPageTemplate', { pageId, target: { kind: 'everywhere' } })
    const result = await executeAgentTool('clearPageTemplate', { pageId })
    expectToolOk(result)
    const page = useEditorStore.getState().site!.pages.find((p) => p.id === pageId)!
    expect(page.template).toBeUndefined()
  })

  it('clearPageTemplate fails when the page is not a template', async () => {
    freshStore()
    const pageId = useEditorStore.getState().site!.pages[0].id
    const result = await executeAgentTool('clearPageTemplate', { pageId })
    expectToolError(result)
    expect(result.error).toContain('not a template')
  })
})

// ---------------------------------------------------------------------------
// insertHtml — <instatic-outlet> maps to a base.outlet node
// ---------------------------------------------------------------------------

describe('executeAgentTool — insertHtml <instatic-outlet>', () => {
  it('imports <instatic-outlet> as a base.outlet node', async () => {
    const { rootId } = freshStore()
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<header>Chrome</header><instatic-outlet></instatic-outlet><footer>End</footer>',
    })
    const nodeIds = expectNodeIds(result)
    expect(nodeIds.length).toBe(3)
    const nodes = useEditorStore.getState().site!.pages[0].nodes
    const moduleIds = nodeIds.map((id) => nodes[id].moduleId)
    expect(moduleIds).toContain('base.outlet')
  })
})

// ---------------------------------------------------------------------------
// duplicateNode
// ---------------------------------------------------------------------------

describe('executeAgentTool — duplicateNode', () => {
  it('clones a node and inserts it immediately after the source', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<h2>Original</h2>',
    })
    const sourceId = expectNodeIds(insertResult)[0]

    const result = await executeAgentTool('duplicateNode', { nodeId: sourceId })
    const clonedNodeId = expectNodeId(result)
    expect(clonedNodeId).toBeTruthy()
    expect(clonedNodeId).not.toBe(sourceId)

    const root = useEditorStore.getState().site!.pages[0].nodes[rootId]
    expect(root.children).toEqual([sourceId, clonedNodeId])
    // Cloned props match source.
    const cloned = useEditorStore.getState().site!.pages[0].nodes[clonedNodeId]
    expect(cloned.props.text).toBe('Original')
    expect(cloned.props.tag).toBe('h2')
  })

  it('produces N clones in arrival order when count is set', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<div></div>',
    })
    const sourceId = expectNodeIds(insertResult)[0]

    const result = await executeAgentTool('duplicateNode', {
      nodeId: sourceId,
      count: 3,
    })
    expectNodeIds(result)

    const root = useEditorStore.getState().site!.pages[0].nodes[rootId]
    // Source + 3 clones, all in order, all distinct ids.
    expect(root.children).toHaveLength(4)
    expect(root.children[0]).toBe(sourceId)
    expect(new Set(root.children).size).toBe(4)
  })

  it('preserves class assignments and breakpoint overrides on clones', async () => {
    const { rootId } = freshStore()
    const cls = useEditorStore.getState().createClass('btn-primary', { color: '#fff' })
    const insertResult = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<p>Hi</p>',
    })
    const sourceId = expectNodeIds(insertResult)[0]
    // Assign the class via the executor so the actual class ID is stored
    await executeAgentTool('assignClass', { nodeId: sourceId, classId: cls.id })
    // Seed a breakpoint override directly on the store — the agent executor
    // would reject this for content props, but the duplicateNode mutation
    // itself is generic and must carry whatever override data exists.
    useEditorStore.getState().setBreakpointOverride(sourceId, 'mobile', { text: 'Hi (mobile)' })

    const result = await executeAgentTool('duplicateNode', { nodeId: sourceId })
    const clonedNodeId = expectNodeId(result)

    const cloned = useEditorStore.getState().site!.pages[0].nodes[clonedNodeId]
    expect(cloned.classIds).toContain(cls.id)
    expect(cloned.breakpointOverrides.mobile?.text).toBe('Hi (mobile)')
  })

  it('fails for a missing source node id', async () => {
    freshStore()
    const result = await executeAgentTool('duplicateNode', { nodeId: 'nonexistent' })
    expectToolError(result)
    expect(result.error).toContain('duplicate')
  })
})

// ---------------------------------------------------------------------------
// updateNodeProps — richtext sanitization (Constraint #299 / security)
// ---------------------------------------------------------------------------

describe('executeAgentTool — updateNodeProps richtext sanitization (Constraint #299)', () => {
  it('strips <script> from a richtext prop updated via the agent', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', { parentId: rootId, html: '<p></p>' })
    const nodeId = expectNodeIds(insertResult)[0]
    await executeAgentTool('updateNodeProps', {
      nodeId,
      patch: { richtext: '<p>Hello</p><script>alert(1)</script>' },
    })
    const page = useEditorStore.getState().site!.pages[0]
    const stored = page.nodes[nodeId].props.richtext as string
    expect(stored).not.toContain('<script>')
    expect(stored).not.toContain('alert(1)')
    expect(stored).toContain('Hello')
  })

  it('strips onerror attribute from richtext prop via agent updateNodeProps', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', { parentId: rootId, html: '<p></p>' })
    const nodeId = expectNodeIds(insertResult)[0]
    await executeAgentTool('updateNodeProps', {
      nodeId,
      patch: { richtext: '<img src=x onerror=alert(1)>' },
    })
    const page = useEditorStore.getState().site!.pages[0]
    const stored = page.nodes[nodeId].props.richtext as string
    expect(stored).not.toContain('onerror')
    expect(stored).not.toContain('alert(1)')
  })

  it('strips javascript: href from richtext prop via agent updateNodeProps', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', { parentId: rootId, html: '<p></p>' })
    const nodeId = expectNodeIds(insertResult)[0]
    await executeAgentTool('updateNodeProps', {
      nodeId,
      patch: { bodyHtml: '<a href="javascript:alert(1)">click</a>' },
    })
    const page = useEditorStore.getState().site!.pages[0]
    const stored = page.nodes[nodeId].props.bodyHtml as string
    expect(stored).not.toContain('javascript:')
  })

  it('preserves safe HTML in richtext prop via agent updateNodeProps', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', { parentId: rootId, html: '<p></p>' })
    const nodeId = expectNodeIds(insertResult)[0]
    const safeHtml = '<p><strong>Bold</strong> and <em>italic</em></p>'
    await executeAgentTool('updateNodeProps', {
      nodeId,
      patch: { richtext: safeHtml },
    })
    const page = useEditorStore.getState().site!.pages[0]
    const stored = page.nodes[nodeId].props.richtext as string
    expect(stored).toContain('Bold')
    expect(stored).toContain('italic')
  })

  it('plain (non-richtext-keyed) props are NOT sanitized by DOMPurify', async () => {
    const { rootId } = freshStore()
    const insertResult = await executeAgentTool('insertHtml', { parentId: rootId, html: '<p></p>' })
    const nodeId = expectNodeIds(insertResult)[0]
    await executeAgentTool('updateNodeProps', {
      nodeId,
      patch: { text: 'Cats & Dogs' },
    })
    const page = useEditorStore.getState().site!.pages[0]
    expect(page.nodes[nodeId].props.text).toBe('Cats & Dogs')
  })
})

// ---------------------------------------------------------------------------
// insertHtml — unsafe HTML is stripped on import (Constraint #299 / security)
// ---------------------------------------------------------------------------

describe('executeAgentTool — insertHtml unsafe HTML stripping (Constraint #299)', () => {
  it('returns actionable guidance when a script-only payload is stripped', async () => {
    const { rootId } = freshStore()
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<script>console.log("hi")</script>',
    })
    expectToolError(result)
    expect(result.error).toContain('write_code_asset')
  })

  it('strips script tags from HTML on import', async () => {
    const { rootId } = freshStore()
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<p>Hello</p><script>alert(1)</script>',
    })
    // The <script> is stripped by stripUnsafe; only the <p> is imported
    expectToolOk(result)

    const page = useEditorStore.getState().site!.pages[0]
    // A base.text node was created from the <p>
    const addedNodes = Object.values(page.nodes).filter((n) => n.moduleId === 'base.text')
    expect(addedNodes.length).toBeGreaterThan(0)
    // No node props contain the script content
    const withScript = addedNodes.find((n) => String(n.props.text).includes('alert'))
    expect(withScript).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// insertHtml — inline style="" and <style> blocks are now applied on import
// ---------------------------------------------------------------------------

describe('executeAgentTool — insertHtml inline styles + <style> blocks', () => {
  it('preserves inline style="" onto the node inlineStyles bag', async () => {
    const { rootId } = freshStore()
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<section style="padding:40px;color:rebeccapurple"><h1>Hi</h1></section>',
    })
    const nodeIds = expectNodeIds(result)

    const page = useEditorStore.getState().site!.pages[0]
    const sectionNode = page.nodes[nodeIds[0]]
    expect(sectionNode.inlineStyles?.color).toBe('rebeccapurple')
    // The `padding` shorthand expands to longhands in the CSSOM enumeration.
    expect(sectionNode.inlineStyles?.paddingTop).toBe('40px')
  })

  it('parses a <style> block into a registry class and binds it to a matching class= token', async () => {
    const { rootId } = freshStore()
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<style>.promo { color: tomato; font-weight: 700; }</style><div class="promo">Sale</div>',
    })
    const nodeIds = expectNodeIds(result)

    const site = useEditorStore.getState().site!
    // The .promo rule landed in the registry (Selectors panel) WITH its styles.
    const promo = Object.values(site.styleRules).find((c) => c.name === 'promo')
    expect(promo).toBeDefined()
    expect(promo!.styles.color).toBe('tomato')

    // The <div class="promo"> node links to that rule by id (not the bare name),
    // so the parsed styles actually resolve at render time.
    const divNode = site.pages[0].nodes[nodeIds[0]]
    expect(divNode.classIds).toContain(promo!.id)
    expect(classNamesForClassIds(site.styleRules, divNode.classIds)).toContain('promo')
  })

  it('registers an ambient <style> selector (body, a:hover, …) as a global rule', async () => {
    const { rootId } = freshStore()
    const result = await executeAgentTool('insertHtml', {
      parentId: rootId,
      html: '<style>a:hover { text-decoration: underline; }</style><a href="/">Home</a>',
    })
    expectToolOk(result)

    const site = useEditorStore.getState().site!
    const ambient = Object.values(site.styleRules).find(
      (c) => c.kind === 'ambient' && c.selector === 'a:hover',
    )
    expect(ambient).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Unknown tool names
// ---------------------------------------------------------------------------

describe('executeAgentTool — unknown tool name', () => {
  it('returns ok: false for tool names the executor does not recognise', async () => {
    freshStore()
    const result = await executeAgentTool('not-a-real-tool', {})
    expectToolError(result)
    expect(result.error).toContain('Unknown')
  })
})
