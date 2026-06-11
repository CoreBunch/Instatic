/**
 * canvasFormPreview — nearest-form resolution + parent-index caching.
 *
 * Both form-preview selectors run for every `base.form-message` node on every
 * store set in every breakpoint frame, so the parent index must be built at
 * most once per `page.nodes` identity (Mutative structural sharing mints a
 * new identity exactly when the tree changes).
 */

import { describe, it, expect } from 'bun:test'
import type { PageNode } from '@core/page-tree'
import { nearestFormNode } from '@site/canvas/canvasFormPreview'

function node(id: string, moduleId: string, children: string[] = []): PageNode {
  return {
    id,
    moduleId,
    props: {},
    breakpointOverrides: {},
    children,
  } as unknown as PageNode
}

function makeNodes(): Record<string, PageNode> {
  return {
    root: node('root', 'base.body', ['form', 'aside']),
    form: node('form', 'base.form', ['fieldset']),
    fieldset: node('fieldset', 'base.container', ['message']),
    message: node('message', 'base.form-message'),
    aside: node('aside', 'base.container', ['orphanMessage']),
    orphanMessage: node('orphanMessage', 'base.form-message'),
  }
}

/** Wrap a nodes map so `Object.values` walks (ownKeys) are countable. */
function countingNodes(nodes: Record<string, PageNode>) {
  let ownKeysCalls = 0
  const proxied = new Proxy(nodes, {
    ownKeys(target) {
      ownKeysCalls++
      return Reflect.ownKeys(target)
    },
  })
  return { nodes: proxied, ownKeysCalls: () => ownKeysCalls }
}

describe('nearestFormNode', () => {
  it('finds the nearest enclosing base.form across intermediate containers', () => {
    const nodes = makeNodes()
    expect(nearestFormNode({ nodes }, 'message')?.id).toBe('form')
  })

  it('returns null when no enclosing form exists', () => {
    const nodes = makeNodes()
    expect(nearestFormNode({ nodes }, 'orphanMessage')).toBeNull()
    expect(nearestFormNode({ nodes }, 'root')).toBeNull()
  })

  it('builds the parent index once per nodes identity', () => {
    const counted = countingNodes(makeNodes())
    const page = { nodes: counted.nodes }

    nearestFormNode(page, 'message')
    const buildsAfterFirst = counted.ownKeysCalls()
    expect(buildsAfterFirst).toBeGreaterThan(0)

    // A selector sweep resolves every form-message node repeatedly with the
    // SAME tree identity — no further full-tree walks allowed.
    for (let i = 0; i < 50; i++) {
      nearestFormNode(page, 'message')
      nearestFormNode(page, 'orphanMessage')
    }
    expect(counted.ownKeysCalls()).toBe(buildsAfterFirst)
  })

  it('rebuilds the parent index when the nodes identity changes', () => {
    const first = countingNodes(makeNodes())
    nearestFormNode({ nodes: first.nodes }, 'message')
    const firstBuilds = first.ownKeysCalls()

    const second = countingNodes(makeNodes())
    expect(nearestFormNode({ nodes: second.nodes }, 'message')?.id).toBe('form')
    expect(second.ownKeysCalls()).toBe(firstBuilds)
  })
})
