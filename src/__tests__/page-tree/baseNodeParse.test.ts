/**
 * parseBaseNodeFields — shared base-node parse equivalence.
 *
 * PageNode and VCNode are both structurally BaseNode. Their tolerant parsers
 * (`parsePageNode` via `parsePage`, `parseVCNode` via `parseVisualComponent`)
 * MUST normalise a persisted node's shared fields IDENTICALLY — previously they
 * were hand-rolled twice and had already drifted. These tests pin the drift
 * shut: the same raw stored node, parsed through the page path and the VC path,
 * yields the same shared BaseNode shape, and both equal `parseBaseNodeFields`.
 */

import { describe, it, expect } from 'bun:test'
import { parsePage, parseBaseNodeFields, type PageNode } from '@core/page-tree'
import { parseVisualComponent } from '@core/visualComponents'

const NODE_ID = 'node-1'

/**
 * A raw stored node that stresses every tolerant default path of the shared
 * base parser: non-string children/classIds entries, a non-object
 * breakpointOverrides entry, an invalid propBindings entry, present
 * inlineStyles, and the optional label/locked/hidden flags.
 */
function rawStoredNode(): Record<string, unknown> {
  return {
    id: NODE_ID,
    moduleId: 'base.text',
    children: ['child-a', 42, 'child-b'],
    props: { text: 'hello' },
    breakpointOverrides: { mobile: { color: 'red' }, junk: 5 },
    classIds: ['c1', 7, 'c2'],
    inlineStyles: { color: 'blue' },
    propBindings: { text: { paramId: 'p1' }, broken: { nope: 1 } },
    label: 'My Node',
    locked: true,
    hidden: false,
  }
}

describe('parseBaseNodeFields — a leaf without a children list', () => {
  it('reads it as an empty list instead of dropping the node', () => {
    const leaf = rawStoredNode()
    delete leaf.children
    expect(parseBaseNodeFields(leaf, 'nodes.node-1').children).toEqual([])
  })

  it('still refuses a children value that is not a list', () => {
    expect(() => parseBaseNodeFields({ ...rawStoredNode(), children: 'child-a' }, 'nodes.node-1')).toThrow(/children/)
  })
})

function parsedViaPage(raw: Record<string, unknown>): PageNode {
  const page = parsePage(
    { id: 'p1', slug: 'home', title: 'Home', rootNodeId: NODE_ID, nodes: { [NODE_ID]: raw } },
    0,
  )
  return page.nodes[NODE_ID]
}

function parsedViaVC(raw: Record<string, unknown>) {
  const vc = parseVisualComponent({
    id: 'vc1',
    name: 'Card',
    tree: { rootNodeId: NODE_ID, nodes: { [NODE_ID]: raw } },
    params: [],
    classIds: [],
    createdAt: 1,
  })
  if (!vc) throw new Error('expected VC to parse')
  return vc.tree.nodes[NODE_ID]
}

/** Strip the derived parentId so we compare only the shared, parsed fields. */
function sharedFields(node: Record<string, unknown>): Record<string, unknown> {
  const { parentId: _parentId, ...rest } = node
  return rest
}

describe('parseBaseNodeFields — page/VC parse equivalence', () => {
  it('normalises the shared BaseNode fields identically across page and VC paths', () => {
    const pageNode = parsedViaPage(rawStoredNode())
    const vcNode = parsedViaVC(rawStoredNode())
    expect(sharedFields(pageNode)).toEqual(sharedFields(vcNode))
  })

  it('matches the standalone parseBaseNodeFields output for both paths', () => {
    const base = parseBaseNodeFields(rawStoredNode(), 'node')
    expect(sharedFields(parsedViaPage(rawStoredNode()))).toEqual(base)
    expect(sharedFields(parsedViaVC(rawStoredNode()))).toEqual(base)
  })

  it('applies the documented tolerance defaults (the drift that was duplicated)', () => {
    const base = parseBaseNodeFields(rawStoredNode(), 'node')
    // non-string children dropped
    expect(base.children).toEqual(['child-a', 'child-b'])
    // non-string classIds dropped
    expect(base.classIds).toEqual(['c1', 'c2'])
    // non-object breakpointOverrides entry dropped, object kept
    expect(base.breakpointOverrides).toEqual({ mobile: { color: 'red' } })
    // invalid propBindings entry dropped
    expect(base.propBindings).toEqual({ text: { paramId: 'p1' } })
    // present inlineStyles kept
    expect(base.inlineStyles).toEqual({ color: 'blue' })
  })

  it('drops missing/empty optional bags identically on both paths', () => {
    const lean = { id: NODE_ID, moduleId: 'base.text', children: [], inlineStyles: {} }
    const pageNode = parsedViaPage({ ...lean })
    const vcNode = parsedViaVC({ ...lean })
    // props default {}, classIds default [], no inlineStyles/propBindings keys
    expect(pageNode.props).toEqual({})
    expect(pageNode.classIds).toEqual([])
    expect('inlineStyles' in pageNode).toBe(false)
    expect('propBindings' in pageNode).toBe(false)
    expect(sharedFields(pageNode)).toEqual(sharedFields(vcNode))
  })

  it('VC path drops a structurally invalid node (missing moduleId) rather than throwing', () => {
    const vc = parseVisualComponent({
      id: 'vc1',
      name: 'Card',
      tree: {
        rootNodeId: NODE_ID,
        nodes: {
          [NODE_ID]: { id: NODE_ID, moduleId: 'base.text', children: [] },
          bad: { id: 'bad', children: [] }, // no moduleId → dropped
        },
      },
      params: [],
      classIds: [],
      createdAt: 1,
    })
    expect(vc).not.toBeNull()
    expect(Object.keys(vc!.tree.nodes)).toEqual([NODE_ID])
  })
})
