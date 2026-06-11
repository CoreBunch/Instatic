/**
 * Shared test helpers for publisher tests.
 * Re-uses the flat-map PageNode structure from the locked types.
 */
import type { Page, PageNode, SiteDocument, Breakpoint } from '@core/page-tree'
import type { ModuleDefinition, IModuleRegistry, AnyModuleDefinition } from '@core/module-engine'
import type { RenderAccumulators } from '@core/publisher'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'
import { DEFAULT_SITE_SETTINGS, reindexNodeParents } from '@core/page-tree'

// Re-exported because legacy publisher tests still reference it.
export { DEFAULT_SITE_SETTINGS }

// ---------------------------------------------------------------------------
// Render accumulators — the mutable output bag every renderNode call needs.
// Tests that don't inspect the CSS / loop / hole sets just pass a fresh one;
// tests that DO inspect them keep a reference and read it back after rendering.
// ---------------------------------------------------------------------------

export function makeAccumulators(): RenderAccumulators {
  return {
    cssMap: new Map<string, string>(),
    jsMap: new Map<string, string>(),
    infiniteLoopIds: new Set<string>(),
    holeNodeIds: new Set<string>(),
  }
}

const DEFAULT_SITE_RUNTIME: SiteDocument['runtime'] = {
  dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
  scripts: {},
}

// ---------------------------------------------------------------------------
// Module fixture factory
// ---------------------------------------------------------------------------

export function makeModule(
  id: string,
  overrides: Partial<ModuleDefinition> = {},
): ModuleDefinition {
  return {
    id,
    name: id,
    category: 'test',
    version: '1.0.0',
    icon: SquareSolidIcon,
    trusted: true,
    canHaveChildren: false,
    schema: {},
    defaults: {},
    component: () => null as never,
    render: (_props, _children) => ({ html: `<div data-module="${id}"></div>` }),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Minimal registry — takes a Record<id, ModuleDefinition>
// ---------------------------------------------------------------------------

export function makeRegistry(
  modules: Record<string, AnyModuleDefinition>,
): IModuleRegistry {
  return {
    register: () => {},
    registerOrReplace: () => {},
    unregister: () => {},
    get: (id) => modules[id],
    getOrThrow: (id) => {
      const m = modules[id]
      if (!m) throw new Error(`Not found: ${id}`)
      return m
    },
    has: (id) => id in modules,
    list: () => Object.values(modules),
    listByCategory: () => {
      const result: Record<string, AnyModuleDefinition[]> = {}
      for (const m of Object.values(modules)) {
        if (!result[m.category]) result[m.category] = []
        result[m.category].push(m)
      }
      return result
    },
    subscribe: () => () => {},
    generation: () => 0,
    isDynamic: (id) => modules[id]?.dynamic === true,
    getStaticPlaceholder: (id) => modules[id]?.staticPlaceholder ?? null,
  } as IModuleRegistry
}

// ---------------------------------------------------------------------------
// Page fixture factory
// ---------------------------------------------------------------------------

type NodeSpec = Partial<Omit<PageNode, 'id' | 'moduleId'>> & { moduleId: string }

export function makePage(
  nodes: Record<string, NodeSpec>,
  rootNodeId = 'root',
): Page {
  const full: Record<string, PageNode> = {}
  for (const [id, spec] of Object.entries(nodes)) {
    full[id] = {
      id,
      moduleId: spec.moduleId,
      props: spec.props ?? {},
      children: spec.children ?? [],
      breakpointOverrides: spec.breakpointOverrides ?? {},
      classIds: spec.classIds ?? [],
      label: spec.label,
      locked: spec.locked ?? false,
      hidden: spec.hidden ?? false,
      dynamicBindings: spec.dynamicBindings,
      propBindings: spec.propBindings,
      ...(spec.inlineStyles ? { inlineStyles: spec.inlineStyles } : {}),
    }
  }
  // Derive the parentId index — mirrors what parse/loadSite do for real trees
  // (the publisher's sizes resolver walks ancestors via parentId).
  reindexNodeParents(full)
  return {
    id: 'page-1',
    slug: 'index',
    title: 'Test Page',
    nodes: full,
    rootNodeId,
  }
}

// ---------------------------------------------------------------------------
// SiteDocument fixture factory
// ---------------------------------------------------------------------------

const DEFAULT_BREAKPOINTS: Breakpoint[] = [
  { id: 'mobile', label: 'Mobile', width: 375, icon: 'smartphone' },
  { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
]

export function makeSite(overrides: Partial<SiteDocument> = {}): SiteDocument {
  return {
    id: 'proj-1',
    name: 'Test SiteDocument',
    pages: [],
    files: [],
    visualComponents: [],
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: DEFAULT_SITE_RUNTIME,
    breakpoints: DEFAULT_BREAKPOINTS,
    settings: structuredClone(DEFAULT_SITE_SETTINGS),
    styleRules: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}
