/**
 * Shared test fixture factories for the instatic test suite.
 *
 * Design goals:
 * - Every factory has sensible defaults → minimal boilerplate per test
 * - Every factory accepts a partial `overrides` object → easy customisation
 * - Factories produce structurally valid objects that match the canonical types
 *
 * Usage:
 *   import { makeModule, makePage, makeSite } from '../fixtures'
 */

import { nanoid } from 'nanoid'
import type { Page, PageNode, SiteDocument } from '@core/page-tree'
import { DEFAULT_BREAKPOINTS, DEFAULT_SITE_SETTINGS, createDefaultSiteExplorerOrganization, reindexNodeParents } from '@core/page-tree'
import type { AnyModuleDefinition } from '@core/module-engine'
import type { VisualComponent, VCNode } from '@core/visualComponents'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'
import { normalizeSitePackageJson } from '@core/site-dependencies/manifest'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'

// ---------------------------------------------------------------------------
// ModuleDefinition factories
// ---------------------------------------------------------------------------

/**
 * Creates a minimal, valid ModuleDefinition stub for testing.
 * render() returns a clean <div> with no props interpolation.
 */
function makeModule(
  id = 'test.stub',
  overrides: Partial<AnyModuleDefinition> = {}
): AnyModuleDefinition {
  return {
    id,
    name: 'Test Stub',
    category: 'Test',
    version: '1.0.0',
    icon: SquareSolidIcon,
    trusted: true,
    canHaveChildren: false,
    schema: {},
    defaults: {},
    component: () => null as never,
    render: (_props, _children) => ({ html: '<div data-testid="stub"></div>' }),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// PageNode factories
// ---------------------------------------------------------------------------

/** Creates a minimal valid PageNode. */
export function makeNode(overrides: Partial<PageNode> & { id?: string } = {}): PageNode {
  return {
    id: overrides.id ?? nanoid(),
    moduleId: overrides.moduleId ?? 'base.div',
    props: overrides.props ?? {},
    breakpointOverrides: overrides.breakpointOverrides ?? {},
    children: overrides.children ?? [],
    label: overrides.label,
    locked: overrides.locked,
    hidden: overrides.hidden,
    classIds: overrides.classIds ?? [],
    dynamicBindings: overrides.dynamicBindings,
    propBindings: overrides.propBindings,
  }
}

// ---------------------------------------------------------------------------
// VCNode / VisualComponent factories
// ---------------------------------------------------------------------------

/** Creates a minimal valid VCNode (= BaseNode). */
export function makeVCNode(overrides: Partial<VCNode> & { id: string; moduleId?: string }): VCNode {
  return {
    moduleId: 'base.container',
    props: {},
    breakpointOverrides: {},
    children: [],
    classIds: [],
    ...overrides,
  }
}

/**
 * Build a flat NodeTree structure from an array of VCNodes.
 * The first node is the root unless rootId is specified separately.
 */
export function makeVCTree(
  rootId: string,
  nodes: VCNode[],
): { nodes: Record<string, VCNode>; rootNodeId: string } {
  const map: Record<string, VCNode> = {}
  for (const n of nodes) map[n.id] = n
  reindexNodeParents(map)
  return { nodes: map, rootNodeId: rootId }
}

/** Creates a minimal valid VisualComponent with a flat tree. */
export function makeVC(overrides: Partial<VisualComponent> & { id: string; name: string }): VisualComponent {
  const defaultRootId = 'vc-root'
  const defaultRoot = makeVCNode({ id: defaultRootId, moduleId: 'base.container' })
  return {
    params: [],
    breakpoints: [],
    classIds: [],
    createdAt: 1_700_000_000_000,
    tree: makeVCTree(defaultRootId, [defaultRoot]),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Page factories
// ---------------------------------------------------------------------------

/** Creates a minimal valid Page with a root node. */
export function makePage(overrides: Partial<Page> = {}): Page {
  const rootId = overrides.rootNodeId ?? 'root'
  const defaultNodes: Record<string, PageNode> = {
    [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [] }),
  }
  const nodes = overrides.nodes ?? defaultNodes
  // Derive the parentId index so fixtures set directly into store state (without
  // going through loadSite) have a consistent O(1) getParent pointer.
  reindexNodeParents(nodes)
  return {
    id: overrides.id ?? 'page-1',
    slug: overrides.slug ?? 'index',
    title: overrides.title ?? 'Home',
    rootNodeId: rootId,
    nodes,
    template: overrides.template,
  }
}

// ---------------------------------------------------------------------------
// SiteDocument factory
// ---------------------------------------------------------------------------

/** Creates a minimal valid SiteDocument. */
export function makeSite(overrides: Partial<SiteDocument> = {}): SiteDocument {
  return {
    id: overrides.id ?? 'site-1',
    name: overrides.name ?? 'Test SiteDocument',
    pages: overrides.pages ?? [makePage()],
    breakpoints: overrides.breakpoints ?? DEFAULT_BREAKPOINTS,
    settings: overrides.settings ?? structuredClone(DEFAULT_SITE_SETTINGS),
    styleRules: overrides.styleRules ?? {},
    explorer: overrides.explorer ?? createDefaultSiteExplorerOrganization(),
    files: overrides.files ?? [],
    visualComponents: overrides.visualComponents ?? [],
    packageJson: overrides.packageJson ?? normalizeSitePackageJson(undefined),
    runtime: overrides.runtime ?? normalizeSiteRuntimeConfig(undefined),
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    updatedAt: overrides.updatedAt ?? 1_700_000_000_000,
  }
}
