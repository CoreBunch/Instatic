import { Type } from '@sinclair/typebox'
import { safeParseJson } from '@core/utils/jsonValidate'

export type PropertiesPanelMode = 'docked' | 'floating'

/**
 * Per-workspace editor layout storage.
 *
 * The persisted shape is namespaced by workspace ('site', 'content', 'data',
 * 'media') so each workspace remembers its own sidebar widths and open/closed
 * state independently. Switching from a workspace with the right sidebar
 * expanded (e.g. `site`) to one with no right panel (e.g. `media`) no longer
 * reserves an empty width on the second workspace.
 *
 * Floating panel positions (drag-and-drop overlays) are kept at the top level
 * — each `FloatingPanelId` is unique to a single workspace, so there is no
 * cross-workspace collision to namespace around.
 */
export const EDITOR_LAYOUT_STORAGE_KEY = 'instatic-editor-layout-v2'

/**
 * 2D position of a draggable / floating panel relative to the viewport.
 * Defined here (the storage layer) so the hook layer can import it without
 * creating a cycle back to the storage layer.
 */
export interface PanelPosition {
  x: number
  y: number
}

export type FloatingPanelId =
  | 'properties'
  | 'site'
  | 'selectors'
  | 'colors'
  | 'typography'
  | 'spacing'
  | 'media'
  | 'dependencies'
  | 'codeeditor'
  | 'agent'
  | 'mediaUploadQueue'
  | 'mediaDetachedInspector'
  | 'mediaBulkEdit'

/**
 * Editor workspaces tracked by the layout persistence layer. These are the
 * four canvas-style admin workspaces — Site through `AdminCanvasLayout`, and
 * Content / Data / Media through `AdminWorkspaceCanvasLayout`. Other admin
 * pages (Plugins, Users, Account, …) render via `AdminPageLayout` and do not
 * participate in this persistence.
 */
export type EditorWorkspaceId = 'site' | 'content' | 'data' | 'media'

export interface StoredWorkspaceLayout {
  /** Left sidebar pixel width (clamped to SIDEBAR_MIN/MAX_WIDTH on read). */
  leftWidth?: number
  /** Right sidebar pixel width. */
  rightWidth?: number
  /** Whether the left sidebar shows a panel (rail expanded). */
  leftOpen?: boolean
  /** Whether the right sidebar is currently expanded. */
  rightOpen?: boolean
  /**
   * Workspace-specific identifier of the panel that is open in the left
   * sidebar. Each workspace uses its own id space:
   *   - site:    'explorer' | 'selectors' | 'framework' | 'dependencies' | ...
   *   - content: 'explorer' | 'agent'
   *   - media:   'folders' | 'storage'
   *   - data:    null (the data workspace has a single toggleable panel)
   */
  activeLeftPanel?: string | null

  // ── Site-workspace-only fields ────────────────────────────────────────────
  /**
   * Active tab inside the consolidated Explorer panel
   * ('layers' | 'pages' | 'media'). Site/content workspaces only.
   */
  explorerPanelTab?: string
  /** ID of the file currently open in the floating code editor (site only). */
  activeEditorFileId?: string | null
  /** Whether the floating code editor is visible (site only). */
  codeEditorPanelOpen?: boolean
  /** Properties panel docked vs floating (site only). */
  propertiesPanelMode?: PropertiesPanelMode
}

interface StoredEditorLayout {
  version: 2
  /**
   * Floating panel positions, keyed by panel id. Each `FloatingPanelId` is
   * unique to a single workspace so positions are kept at the top level.
   */
  panelPositions?: Partial<Record<FloatingPanelId, PanelPosition>>
  /** Per-workspace sidebar / panel state. */
  workspaces?: Partial<Record<EditorWorkspaceId, StoredWorkspaceLayout>>
}

// ---------------------------------------------------------------------------
// Storage schema
//
// `additionalProperties: true` so future fields written by other parts of the
// editor (or older versions) don't crash this reader.

const PanelPositionSchema = Type.Object(
  {
    x: Type.Number(),
    y: Type.Number(),
  },
  { additionalProperties: true },
)

const StoredWorkspaceLayoutSchema = Type.Object(
  {
    leftWidth: Type.Optional(Type.Number()),
    rightWidth: Type.Optional(Type.Number()),
    leftOpen: Type.Optional(Type.Boolean()),
    rightOpen: Type.Optional(Type.Boolean()),
    activeLeftPanel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    explorerPanelTab: Type.Optional(Type.String()),
    activeEditorFileId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    codeEditorPanelOpen: Type.Optional(Type.Boolean()),
    // PropertiesPanelMode is a string union; keep loose to avoid coupling to
    // its exact membership here.
    propertiesPanelMode: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
)

const StoredEditorLayoutSchema = Type.Object(
  {
    version: Type.Literal(2),
    panelPositions: Type.Optional(
      Type.Record(Type.String(), PanelPositionSchema),
    ),
    workspaces: Type.Optional(
      Type.Record(Type.String(), StoredWorkspaceLayoutSchema),
    ),
  },
  { additionalProperties: true },
)

function storageAvailable() {
  return typeof localStorage !== 'undefined'
}

function isPanelPosition(value: unknown): value is PanelPosition {
  if (!value || typeof value !== 'object') return false
  const pos = value as Partial<PanelPosition>
  return typeof pos.x === 'number' && Number.isFinite(pos.x)
    && typeof pos.y === 'number' && Number.isFinite(pos.y)
}

export function readEditorLayout(): StoredEditorLayout | null {
  if (!storageAvailable()) return null
  const raw = localStorage.getItem(EDITOR_LAYOUT_STORAGE_KEY)
  if (!raw) return null
  const result = safeParseJson(raw, StoredEditorLayoutSchema)
  if (!result.ok) return null
  return result.value as StoredEditorLayout
}

function writeEditorLayout(layout: StoredEditorLayout) {
  if (!storageAvailable()) return
  try {
    localStorage.setItem(EDITOR_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // Ignore quota/storage errors. Layout persistence is best-effort.
  }
}

function updateEditorLayout(
  updater: (layout: StoredEditorLayout) => StoredEditorLayout,
) {
  const current = readEditorLayout() ?? { version: 2 as const }
  writeEditorLayout(updater(current))
}

/**
 * Read the stored layout for a single workspace. Returns an empty object when
 * no state has been persisted yet — callers should layer their own defaults.
 */
export function readWorkspaceLayout(
  workspace: EditorWorkspaceId,
): StoredWorkspaceLayout {
  return readEditorLayout()?.workspaces?.[workspace] ?? {}
}

/**
 * Merge a partial layout into a workspace's stored layout. Existing fields
 * are preserved; pass `undefined` to leave them untouched (a `null` value
 * intentionally clears a field for those that accept null).
 */
export function writeWorkspaceLayout(
  workspace: EditorWorkspaceId,
  partial: Partial<StoredWorkspaceLayout>,
) {
  updateEditorLayout((layout) => ({
    ...layout,
    version: 2,
    workspaces: {
      ...layout.workspaces,
      [workspace]: {
        ...layout.workspaces?.[workspace],
        ...partial,
      },
    },
  }))
}

export function readStoredPanelPosition(panelId: FloatingPanelId): PanelPosition | null {
  const position = readEditorLayout()?.panelPositions?.[panelId]
  return isPanelPosition(position) ? position : null
}

export function writeStoredPanelPosition(panelId: FloatingPanelId, position: PanelPosition) {
  updateEditorLayout((layout) => ({
    ...layout,
    version: 2,
    panelPositions: {
      ...layout.panelPositions,
      [panelId]: position,
    },
  }))
}

/**
 * Map a pathname (e.g. `window.location.pathname`) onto one of the editor
 * workspaces, or null when the URL does not point at a canvas workspace.
 *
 * Lives in the storage module (rather than the hook layer) so the synchronous
 * hydration in `store.ts` can call it without dragging React into the
 * eager bundle.
 */
export function workspaceFromPathname(pathname: string): EditorWorkspaceId | null {
  if (pathname.startsWith('/admin/site')) return 'site'
  if (pathname.startsWith('/admin/content')) return 'content'
  if (pathname.startsWith('/admin/data')) return 'data'
  if (pathname.startsWith('/admin/media')) return 'media'
  return null
}
