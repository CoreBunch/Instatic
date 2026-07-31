/**
 * Regression tests for F-0005 — scoped-class cloning during node duplication.
 *
 * Covers:
 *   - cloneScopedClassesForNodeMap helper: scoped classes are cloned with
 *     fresh ids and remapped scope.nodeId; non-scoped classes pass through;
 *     classes scoped to nodes outside the cloned set are left alone.
 *   - duplicateNode: when called with a precomputed nodeIdMap and a
 *     classIdRemap, the cloned subtree's classIds reference the new class ids.
 *   - duplicatePage: cloned page's nodes carry fresh scoped class ids; the
 *     site.styleRules registry gains the new entries; the source page's classes
 *     are unchanged.
 */

import { describe, it, expect } from 'bun:test'
import type { StyleRule, Page, SiteDocument } from '@core/page-tree'
import {
  cloneScopedClassesForNodeMap,
  duplicateNode,
  duplicatePage,
} from '@core/page-tree'
import { makeNode, makePage, makeSite } from '../fixtures'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScopedClass(id: string, nodeId: string, name = id): StyleRule {
  return {
    id,
    name,
    description: 'Node-scoped module style layer',
    scope: { type: 'node', nodeId, role: 'module-style' },
    styles: { backgroundColor: 'red' },
    contextStyles: {},
    tags: ['module-instance'],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

function makeReusableClass(id: string, name = id): StyleRule {
  return {
    id,
    name,
    styles: { color: 'blue' },
    contextStyles: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

// ---------------------------------------------------------------------------
// cloneScopedClassesForNodeMap
// ---------------------------------------------------------------------------

describe('cloneScopedClassesForNodeMap', () => {
  it('clones a node-scoped class with a fresh id and remapped scope.nodeId', () => {
    const idMap = new Map([['n1', 'n1-clone']])
    const classes: Record<string, StyleRule> = {
      'c-scoped': makeScopedClass('c-scoped', 'n1'),
    }
    classes['c-scoped'].stylePriorities = { backgroundColor: 'important' }
    classes['c-scoped'].contextStyles.mobile = { color: 'red' }
    classes['c-scoped'].contextStylePriorities = {
      mobile: { color: 'important' },
    }

    const { added, classIdRemap } = cloneScopedClassesForNodeMap(idMap, classes)

    expect(added).toHaveLength(1)
    expect(added[0].id).not.toBe('c-scoped')
    expect(added[0].scope?.nodeId).toBe('n1-clone')
    expect(added[0].scope?.role).toBe('module-style')
    expect(added[0].styles).toEqual({ backgroundColor: 'red' })
    // The cloned class is a fresh object, not a reference share.
    expect(added[0].styles).not.toBe(classes['c-scoped'].styles)
    expect(added[0].stylePriorities).toEqual({ backgroundColor: 'important' })
    expect(added[0].stylePriorities).not.toBe(classes['c-scoped'].stylePriorities)
    expect(added[0].contextStylePriorities).toEqual({
      mobile: { color: 'important' },
    })
    expect(added[0].contextStylePriorities?.mobile).not.toBe(
      classes['c-scoped'].contextStylePriorities?.mobile,
    )
    // classIdRemap maps old → new id.
    expect(classIdRemap.get('c-scoped')).toBe(added[0].id)
  })

  it('does NOT clone non-scoped (reusable) classes', () => {
    const idMap = new Map([['n1', 'n1-clone']])
    const classes: Record<string, StyleRule> = {
      'c-reusable': makeReusableClass('c-reusable'),
    }

    const { added, classIdRemap } = cloneScopedClassesForNodeMap(idMap, classes)

    expect(added).toHaveLength(0)
    expect(classIdRemap.size).toBe(0)
  })

  it('leaves classes scoped to nodes outside the cloned set alone', () => {
    const idMap = new Map([['n1', 'n1-clone']])
    const classes: Record<string, StyleRule> = {
      'c-other': makeScopedClass('c-other', 'n2'), // n2 not in idMap
    }

    const { added, classIdRemap } = cloneScopedClassesForNodeMap(idMap, classes)

    expect(added).toHaveLength(0)
    expect(classIdRemap.size).toBe(0)
  })

  it('clones multiple scoped classes within a multi-node id map', () => {
    const idMap = new Map([
      ['n1', 'n1-clone'],
      ['n2', 'n2-clone'],
    ])
    const classes: Record<string, StyleRule> = {
      'c1': makeScopedClass('c1', 'n1'),
      'c2': makeScopedClass('c2', 'n2'),
      'c3': makeReusableClass('c3'),
    }

    const { added, classIdRemap } = cloneScopedClassesForNodeMap(idMap, classes)

    expect(added).toHaveLength(2)
    expect(classIdRemap.size).toBe(2)
    const cloneOfC1 = added.find((c) => classIdRemap.get('c1') === c.id)
    const cloneOfC2 = added.find((c) => classIdRemap.get('c2') === c.id)
    expect(cloneOfC1?.scope?.nodeId).toBe('n1-clone')
    expect(cloneOfC2?.scope?.nodeId).toBe('n2-clone')
    // The reusable class was not cloned.
    expect(classIdRemap.has('c3')).toBe(false)
  })

  it('produces unique class ids that differ from source ids', () => {
    const idMap = new Map([
      ['n1', 'n1-clone'],
      ['n2', 'n2-clone'],
    ])
    const classes: Record<string, StyleRule> = {
      'c1': makeScopedClass('c1', 'n1'),
      'c2': makeScopedClass('c2', 'n2'),
    }

    const { added } = cloneScopedClassesForNodeMap(idMap, classes)

    const ids = new Set(added.map((c) => c.id))
    expect(ids.size).toBe(2)
    expect(ids.has('c1')).toBe(false)
    expect(ids.has('c2')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// duplicateNode (with options.nodeIdMap + options.classIdRemap)
// ---------------------------------------------------------------------------

describe('duplicateNode — classIdRemap option', () => {
  it('remaps node classIds via the provided map', () => {
    const page = makePage({
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['n1'] }),
        n1: makeNode({ id: 'n1', classIds: ['c-scoped', 'c-reusable'] }),
      },
    })
    const idMap = new Map([['n1', 'n1-clone']])
    const classIdRemap = new Map([['c-scoped', 'c-scoped-clone']])

    const newId = duplicateNode(page, 'n1', { nodeIdMap: idMap, classIdRemap })

    expect(newId).toBe('n1-clone')
    expect(page.nodes['n1-clone'].classIds).toEqual(['c-scoped-clone', 'c-reusable'])
    // The original node is untouched.
    expect(page.nodes['n1'].classIds).toEqual(['c-scoped', 'c-reusable'])
  })

  it('without classIdRemap, classIds are copied verbatim (legacy behavior)', () => {
    const page = makePage({
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['n1'] }),
        n1: makeNode({ id: 'n1', classIds: ['c1', 'c2'] }),
      },
    })

    const newId = duplicateNode(page, 'n1')

    expect(page.nodes[newId].classIds).toEqual(['c1', 'c2'])
    // Source classIds array reference is preserved on the source.
    expect(page.nodes['n1'].classIds).toEqual(['c1', 'c2'])
  })

  it('classIds fresh-copied so mutating the duplicate does not leak to source', () => {
    const page = makePage({
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['n1'] }),
        n1: makeNode({ id: 'n1', classIds: ['c1'] }),
      },
    })

    const newId = duplicateNode(page, 'n1')

    page.nodes[newId].classIds.push('c2')
    expect(page.nodes['n1'].classIds).toEqual(['c1'])
  })
})

// ---------------------------------------------------------------------------
// duplicatePage — scoped-class cloning
// ---------------------------------------------------------------------------

describe('duplicatePage — scoped-class cloning (F-0005)', () => {
  function makeSiteWithScopedClass(): {
    site: SiteDocument
    sourcePage: Page
    sourceNodeId: string
    sourceClassId: string
  } {
    const sourceNodeId = 'src-node'
    const sourceClassId = 'src-scoped'
    const sourcePage = makePage({
      id: 'p-source',
      slug: 'source',
      title: 'Source',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: [sourceNodeId] }),
        [sourceNodeId]: makeNode({
          id: sourceNodeId,
          moduleId: 'base.container',
          classIds: [sourceClassId, 'c-reusable'],
        }),
      },
    })
    const site = makeSite({
      pages: [sourcePage],
      styleRules: {
        [sourceClassId]: makeScopedClass(sourceClassId, sourceNodeId),
        'c-reusable': makeReusableClass('c-reusable'),
      },
    })
    return { site, sourcePage, sourceNodeId, sourceClassId }
  }

  it('clones the source page\'s scoped class with a fresh id and rewritten scope', () => {
    const { site, sourceClassId } = makeSiteWithScopedClass()

    const newPage = duplicatePage(site, 'p-source', 'Copy', 'copy')

    // Source scoped class is unchanged.
    const sourceClass = site.styleRules[sourceClassId]
    expect(sourceClass).toBeDefined()
    expect(sourceClass.scope?.nodeId).toBe('src-node')

    // A new scoped class exists, scoped to the new page's node.
    const newClasses = Object.values(site.styleRules).filter(
      (c) => c.id !== sourceClassId && c.id !== 'c-reusable',
    )
    expect(newClasses).toHaveLength(1)
    const cloned = newClasses[0]
    expect(cloned.scope?.type).toBe('node')

    // The new node carries the new class id (not the source's id).
    const newNodeId = newPage.rootNodeId
    const newRoot = newPage.nodes[newNodeId]
    const newContainerId = newRoot.children[0]
    const newContainer = newPage.nodes[newContainerId]
    expect(newContainer.classIds).toContain(cloned.id)
    expect(newContainer.classIds).not.toContain(sourceClassId)
    // scope.nodeId points at the new node (not the source).
    expect(cloned.scope?.nodeId).toBe(newContainerId)
  })

  it('reusable (non-scoped) classes are SHARED, not cloned', () => {
    const { site } = makeSiteWithScopedClass()

    duplicatePage(site, 'p-source', 'Copy', 'copy')

    // c-reusable is still there exactly once.
    expect(site.styleRules['c-reusable']).toBeDefined()
    const reusableCount = Object.values(site.styleRules).filter((c) => c.id === 'c-reusable').length
    expect(reusableCount).toBe(1)
  })

  it('the new page\'s node references the cloned class id, not the source class id', () => {
    const { site, sourceClassId } = makeSiteWithScopedClass()

    const newPage = duplicatePage(site, 'p-source', 'Copy', 'copy')

    // Walk every node in the new page; none should reference the source's scoped class id.
    for (const node of Object.values(newPage.nodes)) {
      expect(node.classIds).not.toContain(sourceClassId)
    }
  })

  it('source page\'s nodes still reference the original scoped class id (no mutation)', () => {
    const { site, sourcePage, sourceNodeId, sourceClassId } = makeSiteWithScopedClass()

    duplicatePage(site, 'p-source', 'Copy', 'copy')

    expect(sourcePage.nodes[sourceNodeId].classIds).toContain(sourceClassId)
    const sourceClass = site.styleRules[sourceClassId]
    expect(sourceClass.scope?.nodeId).toBe(sourceNodeId)
  })
})
