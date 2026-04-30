/**
 * Shared test fixture factories for the page-builder test suite.
 *
 * Design goals:
 * - Every factory has sensible defaults → minimal boilerplate per test
 * - Every factory accepts a partial `overrides` object → easy customisation
 * - Factories produce structurally valid objects that match the canonical types
 *
 * Usage:
 *   import { makeModule, makePage, makeProject } from '../fixtures'
 */

import { nanoid } from 'nanoid'
import type { Page, PageNode, Project } from '../../core/page-tree/types'
import { DEFAULT_BREAKPOINTS, DEFAULT_PROJECT_SETTINGS } from '../../core/page-tree/types'
import type { AnyModuleDefinition } from '../../core/module-engine/types'
import { isSafeUrl } from '../../core/publisher/utils'
import { EMPTY_PROJECT_DATA_MODEL } from '../../core/data-model/types'

// ---------------------------------------------------------------------------
// ModuleDefinition factories
// ---------------------------------------------------------------------------

/**
 * Creates a minimal, valid ModuleDefinition stub for testing.
 * render() returns a clean <div> with no props interpolation.
 */
export function makeModule(
  id = 'test.stub',
  overrides: Partial<AnyModuleDefinition> = {}
): AnyModuleDefinition {
  return {
    id,
    name: 'Test Stub',
    category: 'Test',
    version: '1.0.0',
    trusted: true,
    canHaveChildren: false,
    schema: {},
    defaults: {},
    component: () => null as never,
    render: (_props, _children) => ({ html: '<div data-testid="stub"></div>' }),
    ...overrides,
  }
}

/**
 * A container module that renders its children inside a <div>.
 * canHaveChildren: true — use this when testing child-rendering paths.
 */
export function makeContainerModule(id = 'test.container'): AnyModuleDefinition {
  return makeModule(id, {
    name: 'Test Container',
    canHaveChildren: true,
    render: (_props, children) => ({
      html: `<div class="test-container">${children.join('')}</div>`,
    }),
  })
}

/**
 * A module that properly HTML-escapes its `text` prop.
 * Use this for security/XSS conformance tests — demonstrates CORRECT escaping.
 */
export function makeSafeTextModule(id = 'test.safe-text'): AnyModuleDefinition {
  return makeModule(id, {
    name: 'Safe Text Module',
    schema: {
      text: { type: 'text', label: 'Text' },
    },
    defaults: { text: 'Hello World' },
    render: (props, _children) => {
      const raw = String(props['text'] ?? '')
      // Correct implementation: escape all HTML-special characters
      const escaped = raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
      return { html: `<p class="text">${escaped}</p>` }
    },
  })
}

/**
 * A module that properly sanitises link hrefs.
 * Uses isSafeUrl() to block javascript:, data:, vbscript:, and other unsafe schemes.
 * Demonstrates CORRECT URL sanitisation for the conformance suite.
 */
export function makeSafeLinkModule(id = 'test.safe-link'): AnyModuleDefinition {
  return makeModule(id, {
    name: 'Safe Link Module',
    schema: {
      href: { type: 'url', label: 'URL' },
      label: { type: 'text', label: 'Label' },
    },
    defaults: { href: '#', label: 'Click here' },
    render: (props, _children) => {
      const rawHref = String(props['href'] ?? '#')
      // Use isSafeUrl() — same guard as production modules (Constraint #211).
      // This blocks javascript:, data:, vbscript:, and any other non-http(s)/relative URL.
      const safeHref = isSafeUrl(rawHref) ? rawHref : '#'
      const label = String(props['label'] ?? 'Link')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      return { html: `<a href="${safeHref}">${label}</a>` }
    },
  })
}

/**
 * An UNSAFE module that interpolates props WITHOUT escaping.
 * Use this to demonstrate/test XSS vulnerability detection (should FAIL conformance).
 */
export function makeUnsafeTextModule(id = 'test.unsafe-text'): AnyModuleDefinition {
  return makeModule(id, {
    name: 'Unsafe Text Module (intentionally bad)',
    schema: {
      text: { type: 'text', label: 'Text' },
    },
    defaults: { text: 'Hello' },
    // ⚠️ INTENTIONALLY UNSAFE — no escaping
    render: (props, _children) => ({
      html: `<p>${props['text']}</p>`,
    }),
  })
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
    // classIds is optional in PageNode — preserve when provided so callers that
    // test the CSS class pipeline (e.g. makeNode({ classIds: ['cls-1'] })) are
    // not silently dropped (same bug class as publisher/helpers.ts Task #427).
    classIds: overrides.classIds,
  }
}

/**
 * Build a flat `nodes` map from an adjacency description.
 * Each entry is: nodeId → child IDs array.
 *
 * @example
 * const nodes = makeNodeTree({
 *   root: ['a', 'b'],
 *   a: [],
 *   b: ['c'],
 *   c: [],
 * })
 */
export function makeNodeTree(
  adjacency: Record<string, string[]>
): Record<string, PageNode> {
  const nodes: Record<string, PageNode> = {}
  for (const [id, children] of Object.entries(adjacency)) {
    nodes[id] = makeNode({ id, children })
  }
  return nodes
}

// ---------------------------------------------------------------------------
// Page factories
// ---------------------------------------------------------------------------

/** Creates a minimal valid Page with a root node. */
export function makePage(overrides: Partial<Page> = {}): Page {
  const rootId = overrides.rootNodeId ?? 'root'
  const defaultNodes: Record<string, PageNode> = {
    [rootId]: makeNode({ id: rootId, moduleId: 'base.root', children: [] }),
  }
  return {
    id: overrides.id ?? 'page-1',
    slug: overrides.slug ?? 'index',
    title: overrides.title ?? 'Home',
    rootNodeId: rootId,
    nodes: overrides.nodes ?? defaultNodes,
  }
}

/**
 * Create a page with a pre-built node tree (adjacency map style).
 * The root node is automatically added to `nodes` if not present.
 *
 * @example
 * const page = makePageWithTree('root', {
 *   root: ['a', 'b'],
 *   a: [],
 *   b: ['c'],
 *   c: [],
 * })
 */
export function makePageWithTree(
  rootId: string,
  adjacency: Record<string, string[]>
): Page {
  const nodes = makeNodeTree(adjacency)
  return makePage({ rootNodeId: rootId, nodes })
}

// ---------------------------------------------------------------------------
// Project factory
// ---------------------------------------------------------------------------

/** Creates a minimal valid Project. */
export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'Test Project',
    // projectMode is a required field on Project — default to 'html'.
    // Previously omitted, causing TypeScript-invalid objects that masked CSS
    // class pipeline tests (same bug class fixed in publisher/helpers.ts Task #427).
    projectMode: overrides.projectMode ?? 'html',
    pages: overrides.pages ?? [makePage()],
    breakpoints: overrides.breakpoints ?? DEFAULT_BREAKPOINTS,
    settings: overrides.settings ?? DEFAULT_PROJECT_SETTINGS,
    // classes is required on Project — default to empty map.
    // Previously omitted, causing project.classes === undefined which crashes
    // collectClassCSS unless the caller uses the Bug C guard added in Task #427.
    classes: overrides.classes ?? {},
    // files is required on Project (Contribution #595 §1 — files data layer).
    files: overrides.files ?? [],
    // visualComponents is required on Project; default to no reusable components.
    visualComponents: overrides.visualComponents ?? [],
    data: overrides.data ?? structuredClone(EMPTY_PROJECT_DATA_MODEL),
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    updatedAt: overrides.updatedAt ?? 1_700_000_000_000,
  }
}
