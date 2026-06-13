/**
 * convertNodeToComponent.test.ts — Phase 3 data-layer tests
 *
 * Tests for the convertNodeToComponent slice action.
 * Architecture source: Contribution #619 §2, §3, §10
 *
 * Gates:
 *   CNC-1 — subtree cloned with fresh IDs
 *   CNC-2 — original location replaced with VC-ref pointing at new VC
 *   CNC-3 — activeDocument switches to new VC; selectedNodeId cleared
 *   CNC-4 — node-scoped classes hoisted into VC.classIds with scope.nodeId rewritten
 *   CNC-5 — generic site classes stay shared, NOT duplicated
 *   CNC-6 — throws VisualComponentNameError on invalid name
 *   CNC-7 — throws plain Error when called on base.visual-component-ref
 *   CNC-8 — throws plain Error when called on base.body
 *   CNC-9 — site.updatedAt advances on success; no-op on failure
 *   CNC-A — succeeds when activeDocument is null (default page canvas state)
 *   CNC-B — throws when activeDocument is a VC (cannot convert from inside a VC)
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { create } from 'mutative'
import type { SiteDocument, PageNode, StyleRule } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import { VisualComponentNameError } from '@site/store/slices/vcTreeOps'
// Side-effect import: registers base modules in the registry so
// `registry.get('base.text')`, `'base.container'`, etc. resolve at runtime.
// Required for the auto-wrap behavior in convertNodeToComponent (which checks
// `def.canHaveChildren` on the cloned root) to work in this test file.
import '@modules/base/index'

// ---------------------------------------------------------------------------
// Helpers
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
    hasUnsavedChanges: false,
    activeDocument: null,
    activePageId: null,
  })
  return useEditorStore.getState()
}

function setupSite() {
  const s = freshStore()
  s.createSite('CNC Test Site')
  return useEditorStore.getState()
}

/** Read the current site, casting to include visualComponents */
function getSite() {
  return useEditorStore.getState().site as SiteDocument & {
    visualComponents: VisualComponent[]
    classes: Record<string, StyleRule>
  }
}

/** Get a page node from the first page */
function getPage(pageId?: string) {
  const site = getSite()
  const pid = pageId ?? useEditorStore.getState().activePageId!
  return site.pages.find((p) => p.id === pid)!
}

/** Set the active document to the first page */
function activatePage(pageId?: string) {
  const pid = pageId ?? useEditorStore.getState().activePageId!
  useEditorStore.setState({
    activeDocument: { kind: 'page', pageId: pid },
  } as Parameters<typeof useEditorStore.setState>[0])
}

/** Call an action on the store */
function callAction<T>(name: string, ...args: unknown[]): T {
  const s = useEditorStore.getState() as Record<string, unknown>
  return (s[name] as (...a: unknown[]) => T)(...args)
}

/**
 * Build a minimal container node for direct store mutation.
 * We manipulate page.nodes directly so we don't need the insert-node API.
 */
function makePageNode(
  id: string,
  moduleId: string,
  children: string[] = [],
  classIds: string[] = [],
): PageNode {
  return {
    id,
    moduleId,
    props: {},
    breakpointOverrides: {},
    children,
    classIds,
  }
}

/**
 * Inject nodes into the first page's nodes map and attach the root container
 * as a child of the existing page root.
 * Returns the pageId used.
 */
function injectNodesIntoPage(
  rootContainerId: string,
  extraNodes: PageNode[],
): string {
  const state = useEditorStore.getState()
  const pageId = state.activePageId!
  const site = state.site!

  useEditorStore.setState(
    create(state, (draft) => {
      const page = draft.site!.pages.find((p) => p.id === pageId)!
      // Add the root container as a child of the page root
      const pageRoot = page.nodes[page.rootNodeId]
      if (!pageRoot.children.includes(rootContainerId)) {
        pageRoot.children.push(rootContainerId)
      }
      // Register all provided nodes
      for (const n of extraNodes) {
        page.nodes[n.id] = n
      }
    }),
  )
  return pageId
}

// ---------------------------------------------------------------------------
// Gate CNC-1 — subtree cloned with fresh IDs
// ---------------------------------------------------------------------------

describe('Gate CNC-1 — subtree cloned with fresh IDs', () => {
  beforeEach(() => { setupSite() })

  it('page no longer contains original nodes; VC root has new IDs', () => {
    const containerId = 'ctr-1'
    const text1Id = 'txt-1'
    const text2Id = 'txt-2'

    const container = makePageNode(containerId, 'base.container', [text1Id, text2Id])
    const text1 = makePageNode(text1Id, 'base.text')
    const text2 = makePageNode(text2Id, 'base.text')

    injectNodesIntoPage(containerId, [container, text1, text2])
    activatePage()

    const newVcId = callAction<string>('convertNodeToComponent', containerId, 'MyCard')

    const site = getSite()
    const page = getPage()

    // Original IDs must be gone from the page
    expect(page.nodes[containerId]).toBeUndefined()
    expect(page.nodes[text1Id]).toBeUndefined()
    expect(page.nodes[text2Id]).toBeUndefined()

    // A base.visual-component-ref must be on the page
    const refNode = Object.values(page.nodes).find(
      (n) => n.moduleId === 'base.visual-component-ref',
    )
    expect(refNode).toBeDefined()

    // The new VC must exist
    const newVc = site.visualComponents.find((v) => v.id === newVcId)!
    expect(newVc).toBeDefined()

    // VC tree.rootNodeId must NOT be the original container id
    expect(newVc.tree.rootNodeId).not.toBe(containerId)

    // Tree shape after always-wrap:
    //   tree.rootNodeId → fresh base.body wrapper
    //     children[0]   → cloned base.container (the source)
    //       children    → cloned text1, text2
    const vcRoot = newVc.tree.nodes[newVc.tree.rootNodeId]
    expect(vcRoot.moduleId).toBe('base.body')
    expect(vcRoot.children.length).toBe(1)

    const clonedContainer = newVc.tree.nodes[vcRoot.children[0]]
    expect(clonedContainer.moduleId).toBe('base.container')
    expect(clonedContainer.children.length).toBe(2)
    expect(clonedContainer.children).not.toContain(text1Id)
    expect(clonedContainer.children).not.toContain(text2Id)
  })
})

// ---------------------------------------------------------------------------
// Gate CNC-2 — original location replaced with VC-ref pointing at new VC
// ---------------------------------------------------------------------------

describe('Gate CNC-2 — original location replaced with VC-ref', () => {
  beforeEach(() => { setupSite() })

  it('parent children list has the ref node; ref props.componentId equals new VC id', () => {
    const containerId = 'ctr-2'
    const childId = 'txt-2a'

    const container = makePageNode(containerId, 'base.container', [childId])
    const child = makePageNode(childId, 'base.text')

    injectNodesIntoPage(containerId, [container, child])
    activatePage()

    const newVcId = callAction<string>('convertNodeToComponent', containerId, 'HeroBlock')

    const page = getPage()
    const pageRootNode = page.nodes[page.rootNodeId]

    // Parent's children must not include original containerId
    expect(pageRootNode.children).not.toContain(containerId)

    // Find the ref node id from parent's children
    const refNodeId = pageRootNode.children.find((id) => id !== page.rootNodeId)!
    const refNode = page.nodes[refNodeId]
    expect(refNode).toBeDefined()
    expect(refNode.moduleId).toBe('base.visual-component-ref')
    expect(refNode.props.componentId).toBe(newVcId)
  })
})

// ---------------------------------------------------------------------------
// Gate CNC-3 — activeDocument switches to new VC; selectedNodeId cleared
// ---------------------------------------------------------------------------

describe('Gate CNC-3 — activeDocument switches to new VC', () => {
  beforeEach(() => { setupSite() })

  it('activeDocument becomes the new VC and selectedNodeId is null', () => {
    const containerId = 'ctr-3'
    const container = makePageNode(containerId, 'base.container')

    injectNodesIntoPage(containerId, [container])
    activatePage()

    // Pre-select the container node to prove it gets cleared
    useEditorStore.setState({ selectedNodeId: containerId } as Parameters<typeof useEditorStore.setState>[0])

    const newVcId = callAction<string>('convertNodeToComponent', containerId, 'CardBlock')

    const state = useEditorStore.getState()
    expect(state.activeDocument).toEqual({ kind: 'visualComponent', vcId: newVcId })
    expect(state.selectedNodeId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Gate CNC-4 — node-scoped classes hoisted into VC.classIds, scope.nodeId rewritten
// ---------------------------------------------------------------------------

describe('Gate CNC-4 — node-scoped classes hoisted and scope rewritten', () => {
  beforeEach(() => { setupSite() })

  it('hoists node-scoped class to VC.classIds and rewrites scope.nodeId to cloned root id', () => {
    const containerId = 'ctr-4'
    const classId = 'cls-scoped-4'

    // Create the node-scoped CSS class directly in site.styleRules
    const state0 = useEditorStore.getState()
    useEditorStore.setState(
      create(state0, (draft) => {
        draft.site!.styleRules[classId] = {
          id: classId,
          name: '.module-ctr-4',
          styles: {},
          contextStyles: {},
          scope: { type: 'node', nodeId: containerId, role: 'module-style' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      }),
    )

    const container = makePageNode(containerId, 'base.container', [], [classId])
    injectNodesIntoPage(containerId, [container])
    activatePage()

    const newVcId = callAction<string>('convertNodeToComponent', containerId, 'ScopedCard')

    const site = getSite()
    const newVc = site.visualComponents.find((v) => v.id === newVcId)!

    // VC.classIds must include the hoisted class
    expect(newVc.classIds).toContain(classId)

    // The VC root is always a fresh `base.body` wrapper. The cloned source
    // (the original container with its scoped class) is wrapper.children[0].
    const vcRoot = newVc.tree.nodes[newVc.tree.rootNodeId]
    expect(vcRoot.moduleId).toBe('base.body')
    const clonedSourceId = vcRoot.children[0]
    const clonedSource = newVc.tree.nodes[clonedSourceId]

    // scope.nodeId must be the cloned source's id (NOT the original containerId,
    // and NOT the wrapper's id).
    const updatedClass = site.styleRules[classId]
    expect(updatedClass.scope?.nodeId).not.toBe(containerId)
    expect(updatedClass.scope?.nodeId).not.toBe(newVc.tree.rootNodeId)
    expect(updatedClass.scope?.nodeId).toBe(clonedSourceId)

    // The cloned source's classIds must include the class
    expect(clonedSource.classIds).toContain(classId)
  })
})

// ---------------------------------------------------------------------------
// Gate CNC-5 — generic site classes stay shared, NOT duplicated
// ---------------------------------------------------------------------------

describe('Gate CNC-5 — generic classes stay shared, not duplicated', () => {
  beforeEach(() => { setupSite() })

  it('generic class appears on cloned child node classIds but NOT in VC.classIds, and is not duplicated', () => {
    const containerId = 'ctr-5'
    const childId = 'txt-5'
    const genericClassId = 'cls-generic-5'

    // Create a generic class (no scope)
    const state0 = useEditorStore.getState()
    useEditorStore.setState(
      create(state0, (draft) => {
        draft.site!.styleRules[genericClassId] = {
          id: genericClassId,
          name: 'text-bold',
          styles: { fontWeight: 'bold' },
          contextStyles: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      }),
    )

    const beforeClassCount = Object.keys(getSite().styleRules).length

    // Child text node uses the generic class
    const container = makePageNode(containerId, 'base.container', [childId])
    const child = makePageNode(childId, 'base.text', [], [genericClassId])

    injectNodesIntoPage(containerId, [container, child])
    activatePage()

    const newVcId = callAction<string>('convertNodeToComponent', containerId, 'GenericCard')

    const site = getSite()
    const newVc = site.visualComponents.find((v) => v.id === newVcId)!

    // The VC tree shape after always-wrap:
    //   tree.rootNodeId → base.body (wrapper)
    //     children[0]   → cloned base.container (the source)
    //       children[0] → cloned base.text (carries the generic class)
    const vcRoot = newVc.tree.nodes[newVc.tree.rootNodeId]
    expect(vcRoot.moduleId).toBe('base.body')
    const clonedContainer = newVc.tree.nodes[vcRoot.children[0]]
    expect(clonedContainer.moduleId).toBe('base.container')
    const clonedText = newVc.tree.nodes[clonedContainer.children[0]]
    expect(clonedText.moduleId).toBe('base.text')
    expect(clonedText.classIds).toContain(genericClassId)

    // The generic class must NOT be in VC.classIds (only node-scoped classes are hoisted)
    expect(newVc.classIds).not.toContain(genericClassId)

    // No new classes must have been created (class count unchanged)
    const afterClassCount = Object.keys(site.styleRules).length
    expect(afterClassCount).toBe(beforeClassCount)
  })
})

// ---------------------------------------------------------------------------
// Gate CNC-6 — throws VisualComponentNameError on invalid name
// ---------------------------------------------------------------------------

describe('Gate CNC-6 — throws VisualComponentNameError on invalid name', () => {
  beforeEach(() => { setupSite() })

  it('throws with name VisualComponentNameError; does not mutate state', () => {
    const containerId = 'ctr-6'
    const container = makePageNode(containerId, 'base.container')

    injectNodesIntoPage(containerId, [container])
    activatePage()

    // Seed an existing VC so we can trigger PROJECT_DUPLICATE on convert.
    callAction<string>('createVisualComponent', 'Header')

    const beforeVCCount = getSite().visualComponents.length
    const pageNodeCountBefore = Object.keys(getPage().nodes).length

    let threw = false
    let thrownError: unknown
    try {
      // Duplicate name → VisualComponentNameError (PROJECT_DUPLICATE)
      callAction<string>('convertNodeToComponent', containerId, 'Header')
    } catch (err) {
      threw = true
      thrownError = err
    }

    expect(threw).toBe(true)
    expect(thrownError).toBeInstanceOf(VisualComponentNameError)
    expect((thrownError as Error).name).toBe('VisualComponentNameError')

    // State must NOT be mutated
    expect(getSite().visualComponents.length).toBe(beforeVCCount)
    expect(Object.keys(getPage().nodes).length).toBe(pageNodeCountBefore)
    expect(getPage().nodes[containerId]).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Gate CNC-7 — throws plain Error on base.visual-component-ref
// ---------------------------------------------------------------------------

describe('Gate CNC-7 — throws plain Error on base.visual-component-ref', () => {
  beforeEach(() => { setupSite() })

  it('throws when nodeId refers to a base.visual-component-ref node', () => {
    // We need an existing VC to point at
    const existingVcId = callAction<string>('createVisualComponent', 'Existing')

    const refNodeId = 'ref-node-7'
    const refNode = makePageNode(refNodeId, 'base.visual-component-ref')
    refNode.props = { componentId: existingVcId, propOverrides: {}, slotContent: {} }

    injectNodesIntoPage(refNodeId, [refNode])
    activatePage()

    expect(() =>
      callAction<string>('convertNodeToComponent', refNodeId, 'NewVc'),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Gate CNC-8 — throws plain Error when called on base.body
// ---------------------------------------------------------------------------

describe('Gate CNC-8 — throws plain Error on base.body', () => {
  beforeEach(() => { setupSite() })

  it('throws when nodeId is the page rootNodeId (base.body)', () => {
    activatePage()
    const page = getPage()

    expect(() =>
      callAction<string>('convertNodeToComponent', page.rootNodeId, 'RootVc'),
    ).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Gate CNC-9 — site.updatedAt advances on success; no-op on failure
// ---------------------------------------------------------------------------

describe('Gate CNC-9 — site.updatedAt advances on success; no-op on failure', () => {
  beforeEach(() => { setupSite() })

  it('updatedAt after successful conversion is >= updatedAt before', () => {
    const containerId = 'ctr-9'
    const container = makePageNode(containerId, 'base.container')
    injectNodesIntoPage(containerId, [container])
    activatePage()

    const before = getSite().updatedAt
    callAction<string>('convertNodeToComponent', containerId, 'TimestampCard')
    const after = getSite().updatedAt

    expect(after).toBeGreaterThanOrEqual(before)
  })

  it('updatedAt is NOT bumped when name is invalid (error thrown before mutation)', () => {
    const containerId = 'ctr-9b'
    const container = makePageNode(containerId, 'base.container')
    injectNodesIntoPage(containerId, [container])
    activatePage()

    // Empty / whitespace-only names are still rejected — exercise that path.
    const before = getSite().updatedAt

    try {
      callAction<string>('convertNodeToComponent', containerId, '   ')
    } catch {
      // expected
    }

    const after = getSite().updatedAt
    expect(after).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Gate CNC-A — succeeds when activeDocument is null (default page canvas state)
// ---------------------------------------------------------------------------

describe('Gate CNC-A — succeeds when activeDocument is null (default page canvas)', () => {
  beforeEach(() => { setupSite() })

  it('converts a node when activeDocument === null and activePageId is set', () => {
    const containerId = 'ctr-a'
    const container = makePageNode(containerId, 'base.container')
    injectNodesIntoPage(containerId, [container])

    // Leave activeDocument as null — the default page canvas state (no activatePage() call)
    expect(useEditorStore.getState().activeDocument).toBeNull()
    expect(useEditorStore.getState().activePageId).not.toBeNull()

    const newVcId = callAction<string>('convertNodeToComponent', containerId, 'NullDocCard')

    const site = getSite()
    const newVc = site.visualComponents.find((v) => v.id === newVcId)
    expect(newVc).toBeDefined()
    expect(newVc!.name).toBe('NullDocCard')

    // activeDocument should have switched to the new VC
    expect(useEditorStore.getState().activeDocument).toEqual({
      kind: 'visualComponent',
      vcId: newVcId,
    })

    // The original node must be gone from the page
    const page = getPage()
    expect(page.nodes[containerId]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Gate CNC-B — throws when activeDocument.kind === 'visualComponent'
// ---------------------------------------------------------------------------

describe('Gate CNC-B — throws when called from inside a visual component', () => {
  beforeEach(() => { setupSite() })

  it('throws the expected error message when activeDocument is a VC', () => {
    const vcId = callAction<string>('createVisualComponent', 'Existing')

    // Switch to VC canvas mode
    useEditorStore.setState({
      activeDocument: { kind: 'visualComponent', vcId },
    } as Parameters<typeof useEditorStore.setState>[0])

    const containerId = 'ctr-b'
    const container = makePageNode(containerId, 'base.container')
    injectNodesIntoPage(containerId, [container])

    let threw = false
    let thrownMessage = ''
    try {
      callAction<string>('convertNodeToComponent', containerId, 'ShouldFail')
    } catch (err) {
      threw = true
      thrownMessage = err instanceof Error ? err.message : String(err)
    }

    expect(threw).toBe(true)
    expect(thrownMessage).toContain('cannot convert from inside a visual component')

    // State must NOT have been mutated
    expect(getSite().visualComponents.find((v) => v.name === 'ShouldFail')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Gate CNC-C — VC root is ALWAYS base.body (invariant)
// ---------------------------------------------------------------------------
//
// Every NodeTree in this codebase — page trees, VC trees — has `base.body` as
// its root. Pages enforce this by construction; `createVisualComponent`
// enforces it for new VCs; `convertNodeToComponent` enforces it by always
// wrapping the cloned source under a fresh `base.body` root, regardless of
// whether the source happens to be a container.

describe('Gate CNC-C — VC root is always base.body', () => {
  beforeEach(() => { setupSite() })

  it('componentizing a base.text yields a VC root of base.body wrapping the cloned text', () => {
    const textId = 'txt-solo'
    const text = makePageNode(textId, 'base.text')
    injectNodesIntoPage(textId, [text])
    activatePage()

    const newVcId = callAction<string>('convertNodeToComponent', textId, 'TextCard')
    expect(newVcId).toBeTruthy()

    const vc = getSite().visualComponents.find((v) => v.id === newVcId)
    expect(vc).toBeDefined()

    const rootNode = vc!.tree.nodes[vc!.tree.rootNodeId]
    expect(rootNode.moduleId).toBe('base.body')
    expect(rootNode.children).toHaveLength(1)

    const childId = rootNode.children[0]
    const child = vc!.tree.nodes[childId]
    expect(child.moduleId).toBe('base.text')
    // Cloned ID must NOT equal the original (clonePageSubtreeToFlatNodes always allocates fresh IDs).
    expect(childId).not.toBe(textId)
  })

  it('componentizing a base.container ALSO wraps it in a base.body root (always-wrap invariant)', () => {
    const containerId = 'ctr-real'
    const textId = 'txt-inside'
    const container = makePageNode(containerId, 'base.container', [textId])
    const text = makePageNode(textId, 'base.text')
    injectNodesIntoPage(containerId, [container, text])
    activatePage()

    const newVcId = callAction<string>('convertNodeToComponent', containerId, 'CardWithText')
    const vc = getSite().visualComponents.find((v) => v.id === newVcId)
    expect(vc).toBeDefined()

    // Even though the source is a base.container (canHaveChildren: true),
    // the always-wrap rule still applies. The VC root is base.body, with the
    // cloned container as its only child, and the original text as the
    // container's child. Consistent with createVisualComponent and Page trees.
    const rootNode = vc!.tree.nodes[vc!.tree.rootNodeId]
    expect(rootNode.moduleId).toBe('base.body')
    expect(rootNode.children).toHaveLength(1)
    const cloned = vc!.tree.nodes[rootNode.children[0]]
    expect(cloned.moduleId).toBe('base.container')
    expect(cloned.children).toHaveLength(1)
    expect(vc!.tree.nodes[cloned.children[0]].moduleId).toBe('base.text')
  })

  it('componentizing a base.button (canHaveChildren: false) wraps it in base.body', () => {
    const buttonId = 'btn-solo'
    const button = makePageNode(buttonId, 'base.button')
    injectNodesIntoPage(buttonId, [button])
    activatePage()

    const newVcId = callAction<string>('convertNodeToComponent', buttonId, 'ButtonCard')
    const vc = getSite().visualComponents.find((v) => v.id === newVcId)
    expect(vc).toBeDefined()
    const rootNode = vc!.tree.nodes[vc!.tree.rootNodeId]
    expect(rootNode.moduleId).toBe('base.body')
    expect(rootNode.children).toHaveLength(1)
    expect(vc!.tree.nodes[rootNode.children[0]].moduleId).toBe('base.button')
  })
})
