/**
 * Unit tests for `src/core/publisher/dynamicDetection.ts`.
 *
 * Table-driven fixtures cover every auto-detection rule:
 *   1. Module flagged `dynamic: true`
 *   2. Structured `dynamicBindings` with a request-dependent source
 *   2b. Inline `{source.field}` token in a string prop
 *   2c. A `visibleWhen` condition reading a request-dependent source
 *   3. `base.loop` with a `requestDependent: true` loop source
 *   4. `base.visual-component-ref` whose VC tree contains any dynamic node
 *
 * Also covers the VC cycle guard and the "publish-time vs request-time" loop
 * source distinction that is the key invariant of Layer C.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { findDynamicNodeIds } from '../../core/publisher/dynamicDetection'
import { loopSourceRegistry } from '../../core/loops/registry'
import { makePage, makeSite, makeRegistry, makeModule } from '../publisher/helpers'
import type { VisualComponent } from '../../core/visualComponents/schemas'
import type { LoopEntitySource } from '../../core/loops/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLoopSource(id: string, requestDependent?: boolean): LoopEntitySource {
  return {
    id,
    label: id,
    filterSchema: {},
    orderByOptions: [],
    fields: [],
    ...(requestDependent !== undefined ? { requestDependent } : {}),
    fetch: async () => ({ items: [], totalItems: 0 }),
    preview: () => [],
  }
}

function makeVcNodes(
  nodeSpecs: Record<
    string,
    { moduleId: string; props?: Record<string, unknown>; children?: string[] }
  >,
): VisualComponent['tree']['nodes'] {
  const nodes: VisualComponent['tree']['nodes'] = {}
  for (const [id, spec] of Object.entries(nodeSpecs)) {
    nodes[id] = {
      id,
      moduleId: spec.moduleId,
      props: spec.props ?? {},
      breakpointOverrides: {},
      children: spec.children ?? [],
      classIds: [],
    }
  }
  return nodes
}

function makeVc(
  id: string,
  nodeSpecs: Record<
    string,
    { moduleId: string; props?: Record<string, unknown>; children?: string[] }
  >,
  rootNodeId = 'root',
): VisualComponent {
  return {
    id,
    name: id,
    tree: { nodes: makeVcNodes(nodeSpecs), rootNodeId },
    params: [],
    classIds: [],
    createdAt: 0,
  }
}

// ---------------------------------------------------------------------------
// Cleanup — deregister any test loop sources registered during a test
// ---------------------------------------------------------------------------

const registeredTestSourceIds: string[] = []

afterEach(() => {
  for (const id of registeredTestSourceIds) {
    loopSourceRegistry.unregister(id)
  }
  registeredTestSourceIds.length = 0
})

function registerTestSource(source: LoopEntitySource): void {
  loopSourceRegistry.registerOrReplace(source)
  registeredTestSourceIds.push(source.id)
}

// ---------------------------------------------------------------------------
// Rule 1: module flagged dynamic: true
// ---------------------------------------------------------------------------

describe('findDynamicNodeIds — Rule 1: dynamic module flag', () => {
  it('returns empty set for a fully static page', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['text'] },
      text: { moduleId: 'base.text', props: { text: 'Hello' } },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.size).toBe(0)
  })

  it('adds the node id when its module has dynamic: true', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['widget'] },
      widget: { moduleId: 'plugin.live-widget' },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.has('widget')).toBe(true)
    expect(ids.has('root')).toBe(false)
  })

  it('does NOT add a node whose module has dynamic: false (explicit false)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['widget'] },
      widget: { moduleId: 'plugin.stable' },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'plugin.stable': makeModule('plugin.stable', { dynamic: false }),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.size).toBe(0)
  })

  it('marks multiple nodes when multiple dynamic modules exist on the page', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['a', 'b', 'c'] },
      a: { moduleId: 'plugin.live-a' },
      b: { moduleId: 'base.text' },
      c: { moduleId: 'plugin.live-c' },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
      'plugin.live-a': makeModule('plugin.live-a', { dynamic: true }),
      'plugin.live-c': makeModule('plugin.live-c', { dynamic: true }),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.has('a')).toBe(true)
    expect(ids.has('b')).toBe(false)
    expect(ids.has('c')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Rule 2: structured dynamicBindings with request-dependent source
// ---------------------------------------------------------------------------

describe('findDynamicNodeIds — Rule 2: structured dynamicBindings', () => {
  it('adds node id when a dynamicBinding uses route.query source', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['search'] },
      search: {
        moduleId: 'base.text',
        props: { page: 1 },
        dynamicBindings: {
          page: { source: 'route', field: 'query.page' },
        },
      },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.has('search')).toBe(true)
  })

  it('does NOT add node id for publish-time sources (currentEntry, site)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['heading'] },
      heading: {
        moduleId: 'base.text',
        props: { show: true },
        dynamicBindings: {
          show: { source: 'currentEntry', field: 'published' },
        },
      },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Rule 2b: {source.field} inline token in string props
// ---------------------------------------------------------------------------

describe('findDynamicNodeIds — Rule 2b: inline {source.field} tokens', () => {
  it('adds node id when a string prop contains {route.query.*} token', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['result'] },
      result: {
        moduleId: 'base.text',
        props: { text: 'Results for: {route.query.q}' },
      },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.has('result')).toBe(true)
  })

  it('does NOT add node id for publish-time tokens like {route.slug}', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['heading'] },
      heading: {
        moduleId: 'base.text',
        props: { text: 'Page: {route.slug}' },
      },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.size).toBe(0)
  })

  it('does NOT add node id for {currentEntry.*} tokens (publish-time)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['title'] },
      title: {
        moduleId: 'base.text',
        props: { text: '{currentEntry.title}' },
      },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.text': makeModule('base.text'),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Rule 2c: a visibility condition reading a request-dependent source
// ---------------------------------------------------------------------------

describe('findDynamicNodeIds — Rule 2c: visibleWhen', () => {
  const reg = () => makeRegistry({
    'base.body': makeModule('base.body'),
    'base.text': makeModule('base.text'),
  })

  it('adds node id when the condition reads route.query', () => {
    // Whether the node renders at all depends on the URL, so baking it would
    // freeze one visitor's answer into the artefact every visitor gets.
    const page = makePage({
      root: { moduleId: 'base.body', children: ['filtered'] },
      filtered: {
        moduleId: 'base.text',
        props: { text: 'Filtered' },
        visibleWhen: { source: 'route', field: 'query.tag', test: 'isSet' },
      },
    })
    expect(findDynamicNodeIds(page, makeSite(), reg()).has('filtered')).toBe(true)
  })

  it('does NOT add node id when the condition reads the row (publish-time)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['player'] },
      player: {
        moduleId: 'base.text',
        props: { text: 'Video' },
        visibleWhen: { source: 'currentEntry', field: 'video', test: 'isSet' },
      },
    })
    expect(findDynamicNodeIds(page, makeSite(), reg()).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Rule 3: base.loop with request-dependent source
// ---------------------------------------------------------------------------

describe('findDynamicNodeIds — Rule 3: base.loop with requestDependent source', () => {
  it('adds loop node id when loop source is request-dependent', () => {
    registerTestSource(makeLoopSource('test.live-api', true))

    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop1'] },
      loop1: {
        moduleId: 'base.loop',
        props: { sourceId: 'test.live-api' },
      },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.loop': makeModule('base.loop'),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.has('loop1')).toBe(true)
  })

  it('does NOT add loop node id when loop source is publish-time (no requestDependent flag)', () => {
    registerTestSource(makeLoopSource('test.cms-posts'))

    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop1'] },
      loop1: {
        moduleId: 'base.loop',
        props: { sourceId: 'test.cms-posts' },
      },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.loop': makeModule('base.loop'),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.size).toBe(0)
  })

  it('does NOT add loop node id when source has requestDependent: false (explicit)', () => {
    registerTestSource(makeLoopSource('test.cms-pages', false))

    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop1'] },
      loop1: {
        moduleId: 'base.loop',
        props: { sourceId: 'test.cms-pages' },
      },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.size).toBe(0)
  })

  it('does NOT add loop node id when sourceId is empty or missing', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop1'] },
      loop1: {
        moduleId: 'base.loop',
        props: {}, // no sourceId
      },
    })
    const site = makeSite()
    const reg = makeRegistry({ 'base.body': makeModule('base.body') })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.size).toBe(0)
  })

  it('does NOT add loop node id for an unregistered loop source', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop1'] },
      loop1: {
        moduleId: 'base.loop',
        props: { sourceId: 'unregistered.source' },
      },
    })
    const site = makeSite()
    const reg = makeRegistry({ 'base.body': makeModule('base.body') })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Rule 4: base.visual-component-ref with dynamic VC tree
// ---------------------------------------------------------------------------

describe('findDynamicNodeIds — Rule 4: VC ref cascade', () => {
  it('adds the VC ref node id (not inner VC node ids) when the VC tree is dynamic', () => {
    const dynamicVc = makeVc('vc-dynamic', {
      root: { moduleId: 'plugin.live-widget' },
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-dynamic' },
      },
    })
    const site = makeSite({ visualComponents: [dynamicVc] })
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.visual-component-ref': makeModule('base.visual-component-ref'),
      'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    // ref1 (the page-level VC ref node) must be in the set
    expect(ids.has('ref1')).toBe(true)
    // Inner VC node ids should NOT be in the set — the hole boundary is the ref
    expect(ids.has('root')).toBe(false)
  })

  it('does NOT add the VC ref node id when the VC tree is fully static', () => {
    const staticVc = makeVc('vc-static', {
      root: { moduleId: 'base.text', props: { text: 'Hello' } },
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-static' },
      },
    })
    const site = makeSite({ visualComponents: [staticVc] })
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.visual-component-ref': makeModule('base.visual-component-ref'),
      'base.text': makeModule('base.text'),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.size).toBe(0)
  })

  it('handles a VC with a request-dependent loop source inside', () => {
    registerTestSource(makeLoopSource('test.live-feed', true))

    const vcWithLoop = makeVc('vc-loop', {
      root: {
        moduleId: 'base.loop',
        props: { sourceId: 'test.live-feed' },
      },
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-loop' },
      },
    })
    const site = makeSite({ visualComponents: [vcWithLoop] })
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.visual-component-ref': makeModule('base.visual-component-ref'),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.has('ref1')).toBe(true)
  })

  it('treats an unknown VC as static (consistent with render behaviour)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-missing' },
      },
    })
    const site = makeSite({ visualComponents: [] })
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.visual-component-ref': makeModule('base.visual-component-ref'),
    })

    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// VC cycle detection
// ---------------------------------------------------------------------------

describe('findDynamicNodeIds — VC cycle detection', () => {
  it('terminates and treats a directly self-referential VC as dynamic', () => {
    const vcSelf = makeVc('vc-self', {
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-self' },
      },
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-self' },
      },
    })
    const site = makeSite({ visualComponents: [vcSelf] })
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.visual-component-ref': makeModule('base.visual-component-ref'),
    })

    // Must not throw or hang — terminates and marks the ref as dynamic
    expect(() => findDynamicNodeIds(page, site, reg)).not.toThrow()
    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.has('ref1')).toBe(true)
  })

  it('terminates and treats a mutually-referential VC cycle as dynamic', () => {
    // vc-a → vc-b → vc-a (cycle)
    const vcA = makeVc('vc-a', {
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-b' },
      },
    })
    const vcB = makeVc('vc-b', {
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-a' },
      },
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-a' },
      },
    })
    const site = makeSite({ visualComponents: [vcA, vcB] })
    const reg = makeRegistry({
      'base.body': makeModule('base.body'),
      'base.visual-component-ref': makeModule('base.visual-component-ref'),
    })

    expect(() => findDynamicNodeIds(page, site, reg)).not.toThrow()
    const ids = findDynamicNodeIds(page, site, reg)
    expect(ids.has('ref1')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pre-pass / main-pass agreement
//
// The static-loop-body pre-pass (Rule 3.5) and the main per-node classification
// MUST apply the SAME detection rules. The fixtures below place a node that is
// request-dependent via EACH rule both (a) at top level — where the main pass
// must flag it — and (b) inside a STATIC loop body — where the pre-pass must
// promote the enclosing loop to a single hole and suppress the inner node. If
// the two passes disagree on any rule, a request-dependent node inside a static
// loop is silently baked as static HTML.
// ---------------------------------------------------------------------------

describe('findDynamicNodeIds — pre-pass / main-pass rule agreement', () => {
  const baseReg = makeRegistry({
    'base.body': makeModule('base.body'),
    'base.loop': makeModule('base.loop'),
    'base.text': makeModule('base.text'),
    'base.visual-component-ref': makeModule('base.visual-component-ref'),
    'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
  })

  // Each entry builds the SAME dynamic node twice: once standalone, once wrapped
  // in a static loop body. `dynamicNode` is the page-node spec for the node that
  // should be classified request-dependent.
  type RuleCase = {
    name: string
    dynamicNode: { moduleId: string; props?: Record<string, unknown>; children?: string[]; dynamicBindings?: Record<string, { source: string; field: string }> }
    setup?: () => void
    visualComponents?: VisualComponent[]
  }

  const dynamicVc = makeVc('vc-dynamic', {
    root: { moduleId: 'plugin.live-widget' },
  })

  const cases: RuleCase[] = [
    {
      name: 'Rule 1 (dynamic module flag)',
      dynamicNode: { moduleId: 'plugin.live-widget' },
    },
    {
      name: 'Rule 2 (request-dependent dynamicBinding)',
      dynamicNode: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'route', field: 'query.q' } },
      },
    },
    {
      name: 'Rule 2b (inline request-dependent token)',
      dynamicNode: {
        moduleId: 'base.text',
        props: { text: 'Results for: {route.query.q}' },
      },
    },
    {
      name: 'Rule 3 (request-dependent loop source)',
      dynamicNode: { moduleId: 'base.loop', props: { sourceId: 'agree.live-source' } },
      setup: () => registerTestSource(makeLoopSource('agree.live-source', true)),
    },
    {
      name: 'Rule 4 (VC ref → dynamic VC tree)',
      dynamicNode: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-dynamic' },
      },
      visualComponents: [dynamicVc],
    },
  ]

  for (const c of cases) {
    it(`${c.name}: flagged at top level`, () => {
      c.setup?.()
      const page = makePage({
        root: { moduleId: 'base.body', children: ['target'] },
        target: c.dynamicNode,
      })
      const site = makeSite({ visualComponents: c.visualComponents ?? [] })
      const ids = findDynamicNodeIds(page, site, baseReg)
      expect(ids.has('target')).toBe(true)
    })

    it(`${c.name}: promotes the enclosing static loop and suppresses the inner node`, () => {
      c.setup?.()
      const page = makePage({
        root: { moduleId: 'base.body', children: ['loop'] },
        // No sourceId → the loop's OWN source is static; only its body is dynamic.
        loop: { moduleId: 'base.loop', props: {}, children: ['target'] },
        target: c.dynamicNode,
      })
      const site = makeSite({ visualComponents: c.visualComponents ?? [] })
      const ids = findDynamicNodeIds(page, site, baseReg)
      // The static loop becomes the single hole; the inner node is suppressed.
      expect(ids.has('loop')).toBe(true)
      expect(ids.has('target')).toBe(false)
    })
  }

  // Regression for the exact divergence the duplicated rule logic caused: the
  // old `loopBodyIsRequestDependent` skipped (did NOT flag) a VC-ref cycle,
  // while the main pass treated a cycle as dynamic. A self-referential VC ref
  // inside a static loop therefore produced an inner hole (ISS-021) instead of
  // promoting the loop. With one shared predicate both passes agree.
  it('promotes a static loop whose body holds a self-referential (cyclic) VC ref', () => {
    const vcSelf = makeVc('vc-self', {
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-self' },
      },
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: { moduleId: 'base.loop', props: {}, children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-self' },
      },
    })
    const site = makeSite({ visualComponents: [vcSelf] })
    const ids = findDynamicNodeIds(page, site, baseReg)
    expect(ids.has('loop')).toBe(true)
    expect(ids.has('ref1')).toBe(false)
  })
})
