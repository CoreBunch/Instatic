import { produce } from 'immer'
import { nanoid } from 'nanoid'
import type { StateCreator } from 'zustand'
import type { EditorStore } from '../store'
import { renderCache } from '../../engine/renderCache'
import { registry } from '../../module-engine/registry'
import {
  type Project,
  type Page,
  type Breakpoint,
  type ProjectSettings,
  DEFAULT_BREAKPOINTS,
  DEFAULT_PROJECT_SETTINGS,
  createNode,
  addPage,
  deletePage,
  renamePage,
  reorderPages,
  insertNode,
  deleteNode,
  updateNodeProps,
  setBreakpointOverride,
  clearBreakpointOverride,
  renameNode,
  toggleNodeLocked,
  toggleNodeHidden,
  moveNode,
  duplicateNode,
  wrapNode,
} from '../../page-tree'
import {
  clonePackageJson,
  DEFAULT_PROJECT_PACKAGE_JSON,
} from '../../project-dependencies/manifest'
import { EMPTY_PROJECT_DATA_MODEL } from '../../data-model/types'

/** Maximum undo history depth — prevents unbounded memory growth */
const MAX_HISTORY = 50

export interface ProjectSlice {
  project: Project | null

  // Project lifecycle
  createProject: (name: string, id?: string) => Project
  loadProject: (project: Project) => void
  clearProject: () => void
  updateProjectName: (name: string) => void
  /** Phase E — switch between HTML and React project modes */
  setProjectMode: (mode: 'html' | 'react') => void

  // Page mutations
  addPage: (title: string, slug?: string) => Page
  deletePage: (pageId: string) => void
  renamePage: (pageId: string, title: string) => void
  reorderPages: (fromIndex: number, toIndex: number) => void

  // Node mutations (operate on the active page)
  insertNode: (moduleId: string, defaults: Record<string, unknown>, parentId: string, index?: number) => string
  deleteNode: (nodeId: string) => void
  updateNodeProps: (nodeId: string, patch: Record<string, unknown>) => void
  setBreakpointOverride: (nodeId: string, breakpointId: string, patch: Record<string, unknown>) => void
  clearBreakpointOverride: (nodeId: string, breakpointId: string) => void
  renameNode: (nodeId: string, label: string) => void
  toggleNodeLocked: (nodeId: string) => void
  toggleNodeHidden: (nodeId: string) => void
  moveNode: (nodeId: string, newParentId: string, newIndex: number) => void
  duplicateNode: (nodeId: string) => string
  wrapNode: (nodeId: string, containerModuleId: string, defaults?: Record<string, unknown>) => string

  // Breakpoint mutations
  addBreakpoint: (bp: Omit<Breakpoint, 'id'>) => Breakpoint
  updateBreakpoint: (id: string, patch: Partial<Omit<Breakpoint, 'id'>>) => void
  removeBreakpoint: (id: string) => void
  reorderBreakpoints: (fromIndex: number, toIndex: number) => void

  // Project settings mutations
  updateProjectSettings: (patch: Partial<ProjectSettings>) => void

  // ─── Undo / Redo ──────────────────────────────────────────────────────────
  /** Snapshots of previous project states — most recent last */
  _historyPast: Project[]
  /** Snapshots popped by undo, available for redo — most recent last */
  _historyFuture: Project[]
  /** True if there's at least one state to undo to */
  canUndo: boolean
  /** True if there's at least one state to redo to */
  canRedo: boolean
  undo: () => void
  redo: () => void
  /**
   * Call before any undoable mutation to snapshot the current project.
   * Exposed so external code (e.g., batch operations) can manage history.
   */
  pushHistory: () => void
}

function createDefaultProject(name: string, id?: string): Project {
  const rootNode = createNode('base.root')
  const homePage: Page = {
    id: nanoid(),
    title: 'Home',
    slug: 'index',
    rootNodeId: rootNode.id,
    nodes: { [rootNode.id]: rootNode },
  }
  return {
    id: id ?? nanoid(),
    name,
    projectMode: 'html',  // Phase E — default to HTML mode
    pages: [homePage],
    files: [],             // Contribution #595 — files data layer
    visualComponents: [],  // Contribution #619 — visual components data layer
    data: structuredClone(EMPTY_PROJECT_DATA_MODEL),
    packageJson: clonePackageJson(DEFAULT_PROJECT_PACKAGE_JSON),
    breakpoints: DEFAULT_BREAKPOINTS,
    settings: DEFAULT_PROJECT_SETTINGS,
    classes: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function migrateLegacyTextModules(project: Project): Project {
  const migrated = structuredClone(project)

  for (const page of migrated.pages) {
    for (const node of Object.values(page.nodes)) {
      migrateLegacyTextNode(node)
    }
  }

  for (const component of migrated.visualComponents ?? []) {
    migrateLegacyTextNode(component.rootNode)
  }

  return migrated
}

function migrateLegacyTextNode(node: { moduleId: string; props: Record<string, unknown>; childNodes?: unknown[] }) {
  if (node.moduleId === 'base.heading') {
    node.moduleId = 'base.text'
    node.props = {
      text: typeof node.props.text === 'string' ? node.props.text : 'Your Heading Here',
      tag: legacyHeadingTag(node.props.level),
    }
  } else if (node.moduleId === 'base.paragraph') {
    node.moduleId = 'base.text'
    node.props = {
      text: typeof node.props.text === 'string' ? node.props.text : 'Add your text here.',
      tag: 'p',
    }
  }

  for (const child of node.childNodes ?? []) {
    migrateLegacyTextNode(child as { moduleId: string; props: Record<string, unknown>; childNodes?: unknown[] })
  }
}

function legacyHeadingTag(level: unknown): string {
  if (typeof level === 'number' && level >= 1 && level <= 6) return `h${level}`
  const tag = String(level || 'h2').toLowerCase()
  return /^h[1-6]$/.test(tag) ? tag : 'h2'
}

export const createProjectSlice: StateCreator<EditorStore, [], [], ProjectSlice> = (set, get) => {
  // ---------------------------------------------------------------------------
  // Internal helpers — note: these use `get()` before calling set() so they
  // can snapshot the current project for history.
  // ---------------------------------------------------------------------------

  /** Snapshot current project into undo history, then clear redo stack. */
  function pushHistory(): void {
    const { project } = get()
    if (!project) return
    set(
      produce((state: EditorStore) => {
        const snapshot = structuredClone(project)
        state._historyPast.push(snapshot)
        if (state._historyPast.length > MAX_HISTORY) {
          state._historyPast.shift() // evict oldest
        }
        state._historyFuture = []
        state.canUndo = true
        state.canRedo = false
      })
    )
  }

  /** Mutate the active page — auto-snapshots history first. */
  function mutatePage(fn: (page: Page) => void): void {
    pushHistory()
    set(
      produce((state: EditorStore) => {
        if (!state.project) return
        const page = state.project.pages.find((p) => p.id === state.activePageId)
        if (!page) return
        fn(page)
        state.project.updatedAt = Date.now()
        state.hasUnsavedChanges = true
      })
    )
  }

  /** Mutate the project — auto-snapshots history first. */
  function mutateProject(fn: (project: Project) => void): void {
    pushHistory()
    set(
      produce((state: EditorStore) => {
        if (!state.project) return
        fn(state.project)
        state.project.updatedAt = Date.now()
        state.hasUnsavedChanges = true
      })
    )
  }

  return {
    project: null,

    // ─── Undo / Redo ─────────────────────────────────────────────────────────
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,

    pushHistory,

    undo: () => {
      const { _historyPast, project } = get()
      if (_historyPast.length === 0 || !project) return
      const previous = _historyPast[_historyPast.length - 1]
      set(
        produce((state: EditorStore) => {
          state._historyPast.pop()
          state._historyFuture.push(structuredClone(project))
          state.project = previous
          state.canUndo = state._historyPast.length > 0
          state.canRedo = true
          state.hasUnsavedChanges = true
          // Keep activePageId valid
          if (!state.project.pages.find((p) => p.id === state.activePageId)) {
            state.activePageId = state.project.pages[0]?.id ?? null
          }
        })
      )
    },

    redo: () => {
      const { _historyFuture, project } = get()
      if (_historyFuture.length === 0 || !project) return
      const next = _historyFuture[_historyFuture.length - 1]
      set(
        produce((state: EditorStore) => {
          state._historyFuture.pop()
          state._historyPast.push(structuredClone(project))
          state.project = next
          state.canUndo = true
          state.canRedo = state._historyFuture.length > 0
          state.hasUnsavedChanges = true
          // Keep activePageId valid
          if (!state.project.pages.find((p) => p.id === state.activePageId)) {
            state.activePageId = state.project.pages[0]?.id ?? null
          }
        })
      )
    },

    // ─── Project lifecycle ────────────────────────────────────────────────────
    createProject: (name, id) => {
      const project = createDefaultProject(name, id)
      set({
        project,
        packageJson: clonePackageJson(project.packageJson),
        activePageId: project.pages[0].id,
        _historyPast: [],
        _historyFuture: [],
        canUndo: false,
        canRedo: false,
        hasUnsavedChanges: false,
      })
      return project
    },

    loadProject: (project) => {
      // Clear the render cache BEFORE store hydration so stale HTML from a previous
      // project cannot bleed into the canvas after switching projects.
      // (Guideline #307 / Architect message #1216 — critical integration note)
      renderCache.clear()
      const migratedProject = migrateLegacyTextModules(project)
      const packageJson = clonePackageJson(migratedProject.packageJson)
      set({
        project: { ...migratedProject, packageJson },
        packageJson,
        activePageId: migratedProject.pages[0]?.id ?? null,
        _historyPast: [],
        _historyFuture: [],
        canUndo: false,
        canRedo: false,
        hasUnsavedChanges: false,
      })
    },

    clearProject: () => {
      set({
        project: null,
        packageJson: clonePackageJson(DEFAULT_PROJECT_PACKAGE_JSON),
        activePageId: null,
        selectedNodeId: null,
        _historyPast: [],
        _historyFuture: [],
        canUndo: false,
        canRedo: false,
      })
    },

    updateProjectName: (name) => {
      mutateProject((p) => { p.name = name })
    },

    setProjectMode: (mode) => {
      mutateProject((p) => { p.projectMode = mode })
    },

    // ─── Page mutations ───────────────────────────────────────────────────────
    addPage: (title, slug) => {
      let newPage!: Page
      mutateProject((p) => {
        newPage = addPage(p, title, slug ?? title)
      })
      set({ activePageId: newPage.id })
      return newPage
    },

    deletePage: (pageId) => {
      mutateProject((p) => deletePage(p, pageId))
      const { project, activePageId } = get()
      if (activePageId === pageId && project) {
        set({ activePageId: project.pages[0]?.id ?? null })
      }
    },

    renamePage: (pageId, title) => {
      mutateProject((p) => renamePage(p, pageId, title))
    },

    reorderPages: (fromIndex, toIndex) => {
      mutateProject((p) => reorderPages(p, fromIndex, toIndex))
    },

    // ─── Node mutations ───────────────────────────────────────────────────────
    insertNode: (moduleId, defaults, parentId, index) => {
      const mod = registry.get(moduleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      const newNode = createNode(moduleId, resolvedDefaults)
      mutatePage((page) => insertNode(page, newNode, parentId, index))
      return newNode.id
    },

    deleteNode: (nodeId) => {
      mutatePage((page) => deleteNode(page, nodeId))
      if (get().selectedNodeId === nodeId) set({ selectedNodeId: null })
    },

    updateNodeProps: (nodeId, patch) => {
      mutatePage((page) => updateNodeProps(page, nodeId, patch))
    },

    setBreakpointOverride: (nodeId, breakpointId, patch) => {
      mutatePage((page) => setBreakpointOverride(page, nodeId, breakpointId, patch))
    },

    clearBreakpointOverride: (nodeId, breakpointId) => {
      mutatePage((page) => clearBreakpointOverride(page, nodeId, breakpointId))
    },

    renameNode: (nodeId, label) => {
      mutatePage((page) => renameNode(page, nodeId, label))
    },

    toggleNodeLocked: (nodeId) => {
      mutatePage((page) => toggleNodeLocked(page, nodeId))
    },

    toggleNodeHidden: (nodeId) => {
      mutatePage((page) => toggleNodeHidden(page, nodeId))
    },

    moveNode: (nodeId, newParentId, newIndex) => {
      mutatePage((page) => moveNode(page, nodeId, newParentId, newIndex))
    },

    duplicateNode: (nodeId) => {
      let newId = ''
      mutatePage((page) => { newId = duplicateNode(page, nodeId) })
      return newId
    },

    wrapNode: (nodeId, containerModuleId, defaults = {}) => {
      // Auto-resolve the module's schema defaults so the wrapper node renders correctly.
      // Without this, wrapNode(id, 'base.container') produces props:{} → props.tag=undefined
      // → React.createElement(undefined) → "Element type is invalid" crash (Task #414).
      const mod = registry.get(containerModuleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      let wrapperId = ''
      mutatePage((page) => { wrapperId = wrapNode(page, nodeId, containerModuleId, resolvedDefaults) })
      return wrapperId
    },

    // ─── Breakpoint mutations ─────────────────────────────────────────────────
    addBreakpoint: (bp) => {
      const newBp: Breakpoint = { ...bp, id: nanoid(8) }
      mutateProject((p) => { p.breakpoints.push(newBp) })
      return newBp
    },

    updateBreakpoint: (id, patch) => {
      mutateProject((p) => {
        const idx = p.breakpoints.findIndex((b) => b.id === id)
        if (idx !== -1) Object.assign(p.breakpoints[idx], patch)
      })
    },

    removeBreakpoint: (id) => {
      mutateProject((p) => {
        p.breakpoints = p.breakpoints.filter((b) => b.id !== id)
      })
      // If the active breakpoint was removed, fall back to desktop
      if (get().activeBreakpointId === id) {
        set({ activeBreakpointId: 'desktop' })
      }
    },

    reorderBreakpoints: (fromIndex, toIndex) => {
      mutateProject((p) => {
        const [item] = p.breakpoints.splice(fromIndex, 1)
        p.breakpoints.splice(toIndex, 0, item)
      })
    },

    // ─── Project settings mutations ───────────────────────────────────────────
    updateProjectSettings: (patch) => {
      mutateProject((p) => {
        Object.assign(p.settings, patch)
      })
    },
  }
}
