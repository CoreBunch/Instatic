/**
 * Shared test helpers for publisher tests.
 * Re-uses the flat-map PageNode structure from the locked types.
 */
import type { Page, PageNode, Project, Breakpoint } from '../../core/page-tree/types'
import type { ModuleDefinition, IModuleRegistry, AnyModuleDefinition } from '../../core/module-engine/types'
import { EMPTY_PROJECT_DATA_MODEL } from '../../core/data-model/types'
import {
  DEFAULT_COLOR_TOKENS,
  DEFAULT_TYPE_SCALE,
  DEFAULT_PROJECT_SETTINGS,
} from '../../core/page-tree/types'

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
    }
  }
  return {
    id: 'page-1',
    slug: 'index',
    title: 'Test Page',
    nodes: full,
    rootNodeId,
  }
}

// ---------------------------------------------------------------------------
// Project fixture factory
// ---------------------------------------------------------------------------

export const DEFAULT_BREAKPOINTS: Breakpoint[] = [
  { id: 'mobile', label: 'Mobile', width: 375, icon: 'smartphone' },
  { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
]

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    projectMode: 'html',
    pages: [],
    files: [],
    breakpoints: DEFAULT_BREAKPOINTS,
    settings: DEFAULT_PROJECT_SETTINGS,
    classes: {},
    data: structuredClone(EMPTY_PROJECT_DATA_MODEL),
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}
