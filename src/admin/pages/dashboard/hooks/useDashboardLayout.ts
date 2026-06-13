/**
 * useDashboardLayout — server-backed per-user dashboard state.
 *
 * The dashboard layout is a per-user preference: every admin gets their own
 * arrangement of widgets, persisted to the CMS database via the
 * `user_preferences` table. Signing in from a new device restores the
 * exact same layout — no localStorage, no per-browser drift.
 *
 * Flow:
 *
 *   • Mount: render the default layout immediately (no white-flash) and
 *     fire a GET against the server in parallel. If the server has a
 *     saved layout, swap it in once it arrives. If the user has never
 *     saved one (404), the default we already rendered IS the answer.
 *
 *   • Mutate (addWidget / moveWidget / resize / dismissOnboarding / …):
 *     update local state immediately (optimistic) and schedule a
 *     debounced PUT. A burst of mutations during a drag-resize coalesces
 *     to a single network call.
 *
 *   • Saves AFTER the initial GET ONLY. Otherwise the initial render
 *     would over-write the freshly-fetched server state with the default
 *     before the GET completes.
 *
 * Layout model — explicit grid positioning
 * ----------------------------------------
 * Each item carries `{ col, row, size, rows }` and renders at an
 * explicit grid position (`grid-column: col / span size`, `grid-row:
 * row / span rows`). The grid does NOT auto-flow — widgets stay
 * exactly where placed, and the user can leave gaps between cards.
 *
 * Drag-to-move + resize both run a collision-resolution pass after
 * the user-driven change: any other widget that ends up overlapping
 * the moved/resized one gets pushed down (row += height of the
 * authoritative widget) until the layout is overlap-free. The moved
 * item itself is pinned in place during resolution — it never moves
 * away from where the user dropped or resized it to.
 *
 * Schema is validated via TypeBox at both the server boundary AND on
 * read inside the persistence helpers; corrupted blobs surface as
 * thrown errors which we log and recover from by keeping the in-memory
 * default.
 */
import { useEffect, useRef, useState } from 'react'
import {
  getUserPreference,
  setUserPreference,
  type DashboardLayoutPreference,
} from '@core/persistence/userPreferences'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardItem {
  id: string
  /** 1-based start column on the 12-column grid. */
  col: number
  /** 1-based start row. Rows are unbounded; the grid grows downward. */
  row: number
  /** Grid column span (3 .. 12). */
  size: number
  /** Grid row span (2 .. 8) — each row is GRID_ROW_HEIGHT px tall. */
  rows: number
}

interface DashboardLayout {
  items: DashboardItem[]
  onboardingDismissed: boolean
  /**
   * Height (in pixels) of the bottom-docked Block library panel. The user
   * resizes this via the panel's top drag-handle. Persisted per-user so the
   * panel sticks to its preferred height across reloads and devices.
   */
  libraryHeight: number
}

/**
 * Pixel height of one grid row. The grid stylesheet's `grid-auto-rows`
 * MUST stay in sync — moving the value to a single TS constant means the
 * resize handler can compute row deltas from the pointer distance without
 * a magic number duplicated across files.
 */
export const GRID_ROW_HEIGHT = 70
/**
 * 16px between cells in CUSTOMIZE mode. The wider gutter exposes the
 * full perimeter of every card so the 8px edge resize handles can be
 * grabbed without overlapping the neighbour's handle. The CSS
 * `.editing` rule sets the same value on the grid's `--gap` custom
 * property; the JS snap math below uses this constant directly so
 * drag-to-move and edge-resize land on the right cell line.
 */
export const EDITING_GRID_GAP = 16
export const MIN_ROWS = 2
export const MAX_ROWS = 8
export const MIN_COLS = 3
export const MAX_COLS = 12

/**
 * Default / clamped sizes for the bottom-docked Block library panel. The
 * user can drag the top edge to resize between MIN and MAX; the value is
 * persisted alongside the grid layout.
 */
const LIBRARY_DEFAULT_HEIGHT = 340
export const LIBRARY_MIN_HEIGHT = 200
export const LIBRARY_MAX_HEIGHT = 720

/**
 * Stable id for the grid's single droppable surface. Lives here (rather
 * than in `DashboardGrid.tsx`) because the page-level `onDragEnd`
 * handler needs the id and Fast Refresh requires `.tsx` files to export
 * components only — sharing constants with a sibling component file
 * goes through the `.ts` neighbour.
 */
export const GRID_DROP_ID = '__dashboard_grid__'

/**
 * Snap a pointer offset (relative to the grid's top-left) to the
 * nearest `{ col, row }` cell. Used by `DashboardPage`'s `onDragEnd`
 * for both in-grid moves and library drops.
 *
 * We use `EDITING_GRID_GAP` (not `GRID_GAP`) because drag-and-drop
 * only fires in customize mode, where the CSS widens the gap to 16px
 * for handle accessibility. The snap math has to use the same value
 * the layout actually rendered with, or the dropped card lands a
 * column off after a few rows of drift.
 */
export function snapToCell(
  offsetX: number,
  offsetY: number,
  gridWidth: number,
  widgetSize: number,
): { col: number; row: number } {
  const colTrack = (gridWidth - (MAX_COLS - 1) * EDITING_GRID_GAP) / MAX_COLS
  const colStep = colTrack + EDITING_GRID_GAP
  const rowStep = GRID_ROW_HEIGHT + EDITING_GRID_GAP

  // `round` snaps to the nearest line rather than `floor`-ing — feels
  // closer to where the user "aimed" the drop. Clamp into the legal
  // range so the widget stays inside the grid and within the 12-col
  // bound given its width.
  const rawCol = Math.round(offsetX / colStep) + 1
  const rawRow = Math.round(offsetY / rowStep) + 1
  const col = Math.max(1, Math.min(MAX_COLS - widgetSize + 1, rawCol))
  const row = Math.max(1, rawRow)
  return { col, row }
}

/**
 * How long to wait after the most recent mutation before saving to the
 * server. A drag-resize fires many setState calls; 600ms covers a typical
 * gesture without making single-click changes feel laggy.
 */
const SAVE_DEBOUNCE_MS = 600

// ---------------------------------------------------------------------------
// Default layout
// ---------------------------------------------------------------------------

/**
 * Default layout uses ONLY first-party widget ids that the host ships
 * unconditionally. Plugin-owned widgets (Analytics → `visitors` /
 * `top-pages`, future plugins → their own ids) are NOT in the default
 * grid — installing the plugin adds the widget to the registry, but the
 * user has to drop it onto the grid via the "Add block" picker (or the
 * plugin can persist a layout update via the layout API after install).
 *
 * Rationale: a default layout that references plugin ids would leave
 * visual holes on a fresh install where the plugin isn't yet present —
 * bad first impression. Plugins surface via the block picker, the
 * grid only seeds with widgets the host definitely has.
 */
const DEFAULT_LAYOUT: DashboardLayout = {
  items: [
    { id: 'storage',   col: 1,  row: 1,  size: 12, rows: 4 },
    { id: 'pages',     col: 1,  row: 5,  size: 3,  rows: 3 },
    { id: 'posts',     col: 4,  row: 5,  size: 3,  rows: 3 },
    { id: 'media',     col: 7,  row: 5,  size: 3,  rows: 3 },
    { id: 'status',    col: 10, row: 5,  size: 3,  rows: 3 },
    { id: 'activity',  col: 1,  row: 8,  size: 6,  rows: 5 },
    { id: 'publish',   col: 7,  row: 8,  size: 6,  rows: 5 },
    { id: 'plugins',   col: 1,  row: 13, size: 6,  rows: 5 },
    { id: 'domain',    col: 7,  row: 13, size: 6,  rows: 3 },
  ],
  onboardingDismissed: false,
  libraryHeight: LIBRARY_DEFAULT_HEIGHT,
}

// ---------------------------------------------------------------------------
// Collision resolution
// ---------------------------------------------------------------------------

/** Just the grid rectangle (no id) — used by the overlap helper. */
interface GridRect {
  col: number
  row: number
  size: number
  rows: number
}

/**
 * AABB overlap on the integer grid. Two rectangles overlap iff their
 * column ranges intersect AND their row ranges intersect (both
 * half-open).
 */
function overlaps(a: GridRect, b: GridRect): boolean {
  return !(
    a.col + a.size <= b.col ||
    b.col + b.size <= a.col ||
    a.row + a.rows <= b.row ||
    b.row + b.rows <= a.row
  )
}

/**
 * Public helper — does the proposed rectangle (col/row/size/rows) overlap
 * any item in the current layout, excluding `excludeId` (typically the
 * widget currently being dragged so it doesn't collide with itself)?
 *
 * Exposed so `DashboardPage`'s `onDragMove` can decide whether to show
 * the drop-preview ghost — the page invokes `addWidget` / `moveWidget`
 * only on valid drops, and both of those functions also use this guard
 * to reject the drop entirely if the destination is occupied.
 */
export function hasOverlapAt(
  items: readonly DashboardItem[],
  proposed: { col: number; row: number; size: number; rows: number },
  excludeId: string | null,
): boolean {
  for (const item of items) {
    if (excludeId !== null && item.id === excludeId) continue
    if (overlaps(item, proposed)) return true
  }
  return false
}

/**
 * Push every item that overlaps `pinned` (or that overlaps an already-pushed
 * item) downward until the layout is overlap-free. The pinned item never
 * moves — that's the whole point: when the user drops or resizes a card,
 * the card stays exactly where they put it and the world bends around it.
 */
function resolveCollisions(items: readonly DashboardItem[], pinnedId: string): DashboardItem[] {
  const pinned = items.find((i) => i.id === pinnedId)
  if (!pinned) return [...items]

  const others = items
    .filter((i) => i.id !== pinnedId)
    .map((i) => ({ ...i }))
    .sort((a, b) => (a.row - b.row) || (a.col - b.col))

  const settled: DashboardItem[] = [{ ...pinned }]

  for (const item of others) {
    let safety = 200
    while (safety-- > 0) {
      const conflict = settled.find((s) => overlaps(item, s))
      if (!conflict) break
      item.row = conflict.row + conflict.rows
    }
    settled.push(item)
  }

  // Preserve original `items` order for stable React keys / DOM identity.
  const byId = new Map(settled.map((s) => [s.id, s]))
  return items.map((i) => byId.get(i.id) ?? i)
}

// ---------------------------------------------------------------------------
// Normalisation (server payload → runtime)
// ---------------------------------------------------------------------------

function normalizeItem(
  item: { id: string; size: number; rows?: number; col?: number; row?: number },
  fallbackIndex: number,
): DashboardItem {
  return {
    id: item.id,
    size: item.size,
    rows: typeof item.rows === 'number' && item.rows >= MIN_ROWS ? item.rows : MIN_ROWS,
    col: typeof item.col === 'number' && item.col >= 1 ? item.col : 1,
    row: typeof item.row === 'number' && item.row >= 1
      ? item.row
      : 1 + fallbackIndex * (typeof item.rows === 'number' ? item.rows : MIN_ROWS),
  }
}

function clampLibraryHeight(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return LIBRARY_DEFAULT_HEIGHT
  return Math.max(LIBRARY_MIN_HEIGHT, Math.min(LIBRARY_MAX_HEIGHT, Math.round(value)))
}

function normalizeLayout(pref: DashboardLayoutPreference): DashboardLayout {
  return {
    items: pref.items.map((item, idx) => normalizeItem(item, idx)),
    onboardingDismissed: pref.onboardingDismissed,
    libraryHeight: clampLibraryHeight(pref.libraryHeight),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface DashboardLayoutApi {
  layout: DashboardLayout
  /**
   * True while the initial server fetch is in flight. The hook always
   * returns the default layout immediately so callers don't have to
   * branch on this; expose it for callers that want a skeleton instead.
   */
  isLoading: boolean
  /**
   * Append a widget if it's not already on the grid.
   *
   *   • If `col` / `row` are provided (drag-and-drop from the library or
   *     a programmatic placement), the widget lands at that cell and
   *     collision resolution pushes any overlapping siblings down.
   *
   *   • If both are omitted (click-to-add from the library), the widget
   *     lands in the first row below every existing widget — i.e. it
   *     APPENDS rather than overlaps. No siblings get pushed down,
   *     because nothing overlaps the empty space below them.
   */
  addWidget: (id: string, size: number, rows?: number, col?: number, row?: number) => void
  /** Drop a widget from the grid. */
  removeWidget: (id: string) => void
  /** Replace the items array wholesale. Used by the page-level visibility
   *  filter that drops items whose definition is no longer registered. */
  setItems: (next: readonly DashboardItem[]) => void
  /** Move a widget to a new grid position. */
  moveWidget: (id: string, col: number, row: number) => void
  /** Update a widget's column span. */
  resize: (id: string, size: number) => void
  /** Update a widget's row span (vertical height). */
  resizeRows: (id: string, rows: number) => void
  /** Permanently dismiss the onboarding panel for this user. */
  dismissOnboarding: () => void
  /** Bring the onboarding panel back after dismissal. */
  restoreOnboarding: () => void
  /**
   * Set the bottom Block library panel's height in pixels. Clamped to the
   * `LIBRARY_MIN_HEIGHT` / `LIBRARY_MAX_HEIGHT` range. Saves debounce-coalesce
   * with the rest of the layout so a drag-resize gesture lands as one PUT.
   */
  setLibraryHeight: (next: number) => void
}

export function useDashboardLayout(): DashboardLayoutApi {
  // Optimistic render: start with the default layout so the dashboard
  // paints immediately. The server fetch (in the effect below) swaps in
  // the user's saved layout once it returns.
  const [layout, setLayout] = useState<DashboardLayout>(DEFAULT_LAYOUT)
  const [isLoading, setIsLoading] = useState(true)

  // `hasLoadedRef` gates the save effect so the initial render doesn't
  // immediately write the default back to the server, clobbering whatever
  // the user had stored.
  const hasLoadedRef = useRef(false)
  // Pending debounce timer so successive mutations coalesce into one PUT.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 1. Initial load.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const stored = await getUserPreference('dashboard-layout')
        if (cancelled) return
        if (stored) setLayout(normalizeLayout(stored))
      } catch (err) {
        console.error('[dashboard] failed to load layout from server:', err)
      } finally {
        if (!cancelled) {
          hasLoadedRef.current = true
          setIsLoading(false)
        }
      }
    })()

    // One-time cleanup of the pre-server-backed localStorage layout key.
    // The hook no longer reads from localStorage; an orphan entry just
    // wastes a few KB per browser. Pre-release, no migration code needed —
    // just nuke it on mount.
    if (typeof window !== 'undefined') {
      try { window.localStorage.removeItem('instatic-admin-dashboard-layout-v3') } catch { /* private browsing */ }
    }

    return () => { cancelled = true }
  }, [])

  // 2. Debounced save on every layout change AFTER initial load.
  //    We don't save during loading because (a) the value is just the
  //    default placeholder, and (b) it would race the initial GET.
  useEffect(() => {
    if (!hasLoadedRef.current) return
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      void setUserPreference('dashboard-layout', layout).catch((err) => {
        console.error('[dashboard] failed to save layout to server:', err)
      })
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [layout])

  // 3. Flush any pending save on unmount so a quick mutate-then-navigate
  //    doesn't lose the last change. Fire-and-forget — the request is
  //    same-origin and the browser will complete it after the React tree
  //    tears down. (For mobile-network reliability we could switch to
  //    `navigator.sendBeacon`, but that requires a different payload
  //    shape; punt until needed.)
  useEffect(() => {
    return () => {
      if (saveTimerRef.current === null) return
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
      if (!hasLoadedRef.current) return
      void setUserPreference('dashboard-layout', layout).catch((err) => {
        console.error('[dashboard] failed to flush layout on unmount:', err)
      })
    }
  }, [layout])

  const addWidget = (id: string, size: number, rows: number = 3, col?: number, row?: number) => {
    setLayout((curr) => {
      if (curr.items.some((i) => i.id === id)) return curr
      // Click-to-add (no explicit cell): append at the first row below
      // every existing widget — that's always empty space by definition,
      // so the drop succeeds with no overlap check needed.
      if (col === undefined || row === undefined) {
        const bottomRow = curr.items.reduce(
          (max, item) => Math.max(max, item.row + item.rows),
          1,
        )
        const nextItems = [
          ...curr.items,
          { id, size, rows, col: 1, row: bottomRow },
        ]
        return { ...curr, items: nextItems }
      }
      // Explicit cell (drag-and-drop from library): the new widget must
      // fit in empty space without pushing siblings. If the proposed
      // rectangle overlaps anything, reject the drop entirely — the
      // page-level dragEnd handler only invokes addWidget when the
      // pre-drop preview was valid, but we re-verify here so the layout
      // model itself is the source of truth.
      const proposed = { col, row, size, rows }
      if (hasOverlapAt(curr.items, proposed, null)) return curr
      const nextItems = [...curr.items, { id, size, rows, col, row }]
      return { ...curr, items: nextItems }
    })
  }

  const removeWidget = (id: string) => {
    setLayout((curr) => ({ ...curr, items: curr.items.filter((i) => i.id !== id) }))
  }

  const setItems = (next: readonly DashboardItem[]) => {
    setLayout((curr) => ({ ...curr, items: [...next] }))
  }

  const moveWidget = (id: string, col: number, row: number) => {
    setLayout((curr) => {
      const target = curr.items.find((i) => i.id === id)
      if (!target) return curr
      const clampedCol = Math.max(1, Math.min(MAX_COLS - target.size + 1, col))
      const clampedRow = Math.max(1, row)
      if (target.col === clampedCol && target.row === clampedRow) return curr
      // The destination must be empty (excluding the source widget itself
      // — it's moving out of its current cell). If the proposed rect
      // overlaps any sibling, the move is rejected and the widget stays
      // exactly where it was. No sliding, no auto-rearrangement.
      const proposed = { col: clampedCol, row: clampedRow, size: target.size, rows: target.rows }
      if (hasOverlapAt(curr.items, proposed, id)) return curr
      const nextItems = curr.items.map((i) =>
        i.id === id ? { ...i, col: clampedCol, row: clampedRow } : i,
      )
      return { ...curr, items: nextItems }
    })
  }

  const resize = (id: string, size: number) => {
    setLayout((curr) => {
      const target = curr.items.find((i) => i.id === id)
      if (!target || target.size === size) return curr
      const clampedSize = Math.max(MIN_COLS, Math.min(MAX_COLS - target.col + 1, size))
      const nextItems = curr.items.map((i) =>
        i.id === id ? { ...i, size: clampedSize } : i,
      )
      return { ...curr, items: resolveCollisions(nextItems, id) }
    })
  }

  const resizeRows = (id: string, rows: number) => {
    setLayout((curr) => {
      const target = curr.items.find((i) => i.id === id)
      if (!target || target.rows === rows) return curr
      const clampedRows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, rows))
      const nextItems = curr.items.map((i) =>
        i.id === id ? { ...i, rows: clampedRows } : i,
      )
      return { ...curr, items: resolveCollisions(nextItems, id) }
    })
  }

  const dismissOnboarding = () => {
    setLayout((curr) => ({ ...curr, onboardingDismissed: true }))
  }

  const restoreOnboarding = () => {
    setLayout((curr) => ({ ...curr, onboardingDismissed: false }))
  }

  const setLibraryHeight = (next: number) => {
    setLayout((curr) => {
      const clamped = clampLibraryHeight(next)
      if (curr.libraryHeight === clamped) return curr
      return { ...curr, libraryHeight: clamped }
    })
  }

  return {
    layout,
    isLoading,
    addWidget,
    removeWidget,
    setItems,
    moveWidget,
    resize,
    resizeRows,
    dismissOnboarding,
    restoreOnboarding,
    setLibraryHeight,
  }
}
