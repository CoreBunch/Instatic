/**
 * BlockLibrary — bottom-docked block picker, modelled on macOS's
 * "Edit widgets" tray.
 *
 * One-copy model
 * --------------
 * Every widget lives in exactly one place: the dashboard OR the library,
 * never both. Adding a widget moves it from the library to the dashboard;
 * dragging a widget from the dashboard back into the library removes it
 * from the grid. The parent (`DashboardPage`) filters active widgets out
 * before passing the list down, so the library never has to worry about
 * "added" vs. "available" UI states.
 *
 * Layout
 * ------
 *   • Anchored to the bottom edge, full width. The user can drag the top
 *     edge to resize the panel height (persisted per-user via
 *     `useDashboardLayout.setLibraryHeight`).
 *
 *   • Categorised — first-party widgets ship under "System", everything
 *     else groups by `ownerId` (the registering plugin). Each category's
 *     items flex-wrap; the panel scrolls vertically across categories.
 *
 *   • Each item is a LIVE preview of the real widget renderer at its
 *     natural default size (`defaultSize × default rows` on the same grid
 *     metrics as the dashboard).
 *
 *   • Each item is a dnd-kit drag source (drag onto a specific grid cell)
 *     AND a click target (click to append to the bottom of the grid).
 *
 *   • The library itself is a dnd-kit drop target — dragging a widget
 *     from the dashboard onto the library removes it from the grid.
 *
 * Lives outside `DashboardGrid` as a sibling under the page-level
 * `DndContext` so dragged previews can travel between the two surfaces.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { SearchSolidIcon } from 'pixel-art-icons/icons/search-solid'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import { Grid2x22SolidIcon } from 'pixel-art-icons/icons/grid-2x2-2-solid'
import type { DashboardWidgetDefinition } from '@core/dashboard'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import { useDelayedUnmount } from '@ui/lib/useDelayedUnmount'
import {
  GRID_ROW_HEIGHT,
  LIBRARY_MAX_HEIGHT,
  LIBRARY_MIN_HEIGHT,
} from '../hooks/useDashboardLayout'
import styles from './BlockLibrary.module.css'

/**
 * Must match the longest exit-animation duration in
 * `BlockLibrary.module.css` (the panel/pill `slideOut`/`pillOut`
 * keyframes). If you bump those CSS timings, bump this too — the hook
 * unmounts after this many ms, so a smaller value here truncates the
 * exit animation.
 */
const EXIT_DURATION_MS = 220

/**
 * Prefix used for library-sourced draggables. The page-level dragEnd
 * handler strips this to find the widget id and route the drop through
 * `addWidget(...)` instead of `moveWidget(...)`.
 */
export const LIBRARY_DRAG_PREFIX = 'library:'

/**
 * Stable id for the library's single droppable surface. The page-level
 * dragEnd handler reads `event.over.id` against this constant to decide
 * whether a grid-sourced drag should be turned into a `removeWidget(...)`
 * call. Lives next to `LIBRARY_DRAG_PREFIX` so both library DnD
 * identifiers live in one place.
 */
export const LIBRARY_DROP_ID = '__dashboard_block_library__'

/** Default rows for the preview tile when the widget definition doesn't
 *  carry an explicit row hint — matches what `addWidget` lands with. */
const PREVIEW_DEFAULT_ROWS = 3

/**
 * Customize-mode grid gap (px). The library mirrors the dashboard's
 * customize-mode metric (`EDITING_GRID_GAP = 16`) so each preview tile
 * lays out at the exact pixel width its widget would have on the actual
 * dashboard. Kept here as a local constant rather than imported because
 * the library is conceptually pinned to "what the destination looks
 * like when the library is open" — i.e. always customize-mode gap.
 */
const LIBRARY_GRID_GAP = 16

interface BlockLibraryProps {
  /**
   * Whether the user has the expanded panel open (clicked "Add block").
   * Drives the slow slide-up / slide-down animations of the panel via
   * `useDelayedUnmount`. Independent of the drag lifecycle — the panel
   * stays "open" while a library-sourced drag is in flight, just
   * visually hidden via CSS so the pill can take its place without a
   * jarring exit animation.
   */
  panelOpen: boolean
  /**
   * True while a dnd-kit drag is in progress in the page's shared
   * context. Mounts the minimized drop-pill instantly and hides the
   * expanded panel via CSS (no slide-out exit) for the duration of the
   * drag. When the drag ends, the pill unmounts INSTANTLY — no exit
   * animation — and the panel re-appears if it was open. The pill's
   * close is intentionally not animated: when the library was never
   * opened by the user, a slide-down animation reads as a "library
   * closing" event for a library they never opened, which the user
   * flagged as a visual glitch.
   */
  dragging: boolean
  /**
   * Widgets that are NOT currently on the dashboard. The parent owns the
   * filtering — it already knows which widgets are active and can keep
   * the library in lockstep with the layout state.
   */
  availableWidgets: readonly DashboardWidgetDefinition[]
  height: number
  onHeightChange: (next: number) => void
  onAdd: (widgetId: string, defaultSize: number) => void
  onClose: () => void
  /**
   * True when the active drag is sourced from the dashboard grid (as
   * opposed to a library tile). Drives the minimized pill's "drop here
   * to put back" affordance — for library-sourced drags the pill is
   * informational only and dropping on it cancels the drag.
   */
  draggingFromGrid: boolean
}

interface CategoryGroup {
  /** Display label. */
  label: string
  /** Internal id (`'core'` or plugin ownerId). Used for React keys. */
  ownerId: string
  /** Description shown under the label. */
  description: string
  /** Widgets belonging to this category, in registration order. */
  widgets: DashboardWidgetDefinition[]
}

/**
 * Group widgets by `ownerId` and humanise the labels. First-party widgets
 * land under "System". Plugin-owned widgets group under the plugin's
 * `ownerId`, which is a slug like `examples.analytics` — we keep that as
 * the label (acceptable as-is for plugin authors who namespace their ids
 * deliberately). Future work: resolve plugin display name from the
 * runtime manifest if we want prettier labels.
 */
function groupWidgetsByOwner(widgets: readonly DashboardWidgetDefinition[]): CategoryGroup[] {
  const groups = new Map<string, CategoryGroup>()
  for (const w of widgets) {
    let group = groups.get(w.ownerId)
    if (!group) {
      group = {
        label: w.ownerId === 'core' ? 'System' : w.ownerId,
        ownerId: w.ownerId,
        description:
          w.ownerId === 'core' ? 'Built-in blocks' : 'Plugin-provided blocks',
        widgets: [],
      }
      groups.set(w.ownerId, group)
    }
    group.widgets.push(w)
  }
  // System first, then plugins in alphabetical order. Predictable order
  // matters for keyboard navigation and visual stability when new plugins
  // come online during the same session.
  return Array.from(groups.values()).sort((a, b) => {
    if (a.ownerId === 'core') return -1
    if (b.ownerId === 'core') return 1
    return a.label.localeCompare(b.label)
  })
}

export function BlockLibrary({
  panelOpen,
  dragging,
  availableWidgets,
  height,
  onHeightChange,
  onAdd,
  onClose,
  draggingFromGrid,
}: BlockLibraryProps) {
  // Panel mount/unmount lifecycle — tracks panelOpen ONLY. Drag state
  // hides the panel via CSS without triggering the slide-out animation
  // so a drop after a grid-to-grid move doesn't flash the panel exit.
  const { mounted: panelMounted, exiting: panelExiting } = useDelayedUnmount(
    panelOpen,
    EXIT_DURATION_MS,
  )

  return (
    <>
      {panelMounted && (
        <ExpandedPanel
          availableWidgets={availableWidgets}
          height={height}
          onHeightChange={onHeightChange}
          onAdd={onAdd}
          onClose={onClose}
          hiddenDuringDrag={dragging}
          exiting={panelExiting}
        />
      )}
      {dragging && (
        <MinimizedPill draggingFromGrid={draggingFromGrid} />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Expanded panel — the full library tray
// ---------------------------------------------------------------------------

interface ExpandedPanelProps {
  availableWidgets: readonly DashboardWidgetDefinition[]
  height: number
  onHeightChange: (next: number) => void
  onAdd: (widgetId: string, defaultSize: number) => void
  onClose: () => void
  /**
   * When `true`, the panel is rendered with `display: none` — the user
   * has started a drag and the minimized pill is the active drop
   * target. Keeping the panel mounted (just hidden) preserves its
   * scroll position and avoids triggering the slide-out exit animation,
   * which would otherwise read as "library closing" every time the
   * user starts a drag.
   */
  hiddenDuringDrag: boolean
  /** True while the slide-out animation is playing. */
  exiting: boolean
}

function ExpandedPanel({
  availableWidgets,
  height,
  onHeightChange,
  onAdd,
  onClose,
  hiddenDuringDrag,
  exiting,
}: ExpandedPanelProps) {
  const [query, setQuery] = useState('')
  const q = query.toLowerCase().trim()

  const filtered = q
    ? availableWidgets.filter((w) =>
        w.name.toLowerCase().includes(q) ||
        w.description.toLowerCase().includes(q) ||
        w.ownerId.toLowerCase().includes(q),
      )
    : availableWidgets
  const filteredGroups = groupWidgetsByOwner(filtered)

  const everythingPlaced = availableWidgets.length === 0

  return (
    <aside
      className={cn(
        styles.panel,
        exiting && styles.panelExiting,
        hiddenDuringDrag && styles.panelHiddenDuringDrag,
      )}
      role="dialog"
      aria-label="Block library"
      style={{
        ['--lib-height' as string]: `${height}px`,
        ['--lib-row-h' as string]: `${GRID_ROW_HEIGHT}px`,
        ['--lib-gap' as string]: `${LIBRARY_GRID_GAP}px`,
      }}
    >
      <ResizeHandle height={height} onHeightChange={onHeightChange} />

      <header className={styles.head}>
        <div className={styles.title}>
          <h3>Block library</h3>
          <p>Drag a block onto the grid, or click to append it to the bottom.</p>
        </div>
        <div className={styles.headEnd}>
          <div className={styles.search}>
            <SearchSolidIcon size={12} aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search blocks…"
              aria-label="Search blocks"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Close block library"
            onClick={onClose}
          >
            <CloseIcon size={12} aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div className={styles.body}>
        {/* Inner container mirrors the dashboard's centered 1220px
            content column so the 12-column library strip lines up
            horizontally with the 12-column dashboard grid — column N
            in the library sits directly above column N on the grid,
            and tile widths match cell widths exactly. */}
        <div className={styles.container}>
          {everythingPlaced && (
            <div className={styles.everythingPlaced} role="status">
              <span className={styles.everythingPlacedIcon}>
                <ArrowDownIcon size={14} aria-hidden="true" />
              </span>
              <strong>Every block is on your dashboard.</strong>
              <span>Drag a block from the grid down here to put it back in the library.</span>
            </div>
          )}
          {!everythingPlaced && filteredGroups.length === 0 && (
            <p className={styles.empty}>No blocks match “{query}”.</p>
          )}
          {filteredGroups.map((group) => (
            <section className={styles.group} key={group.ownerId}>
              <header className={styles.groupHead}>
                <span className={styles.groupLabel}>
                  {group.ownerId === 'core' ? 'System' : `Plugin · ${group.label}`}
                </span>
                <span className={styles.groupDescription}>{group.description}</span>
                <span className={styles.groupCount}>
                  {group.widgets.length} block{group.widgets.length === 1 ? '' : 's'}
                </span>
              </header>
              <div className={styles.strip}>
                {group.widgets.map((widget) => (
                  <LibraryItem key={widget.id} widget={widget} onAdd={onAdd} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Minimized pill — drop target shown during an active drag
// ---------------------------------------------------------------------------

interface MinimizedPillProps {
  /**
   * True when the active drag came from the dashboard grid. Changes
   * the pill's label / accent to clearly read as "drop here to remove";
   * for library-sourced drags the pill is informational and dropping
   * on it is a no-op (cancel).
   */
  draggingFromGrid: boolean
}

/**
 * The pill is a self-contained component mounted only while a drag is
 * in progress. It mounts on drag-start (plays the `pillIn` animation)
 * and unmounts instantly on drag-end — no exit animation. That's the
 * deliberate fix for the "library exit flashing after grid-to-grid
 * move" bug: when the library was never opened by the user, there's
 * no library-closing event to communicate, so the pill just vanishes.
 *
 * It owns the `useDroppable({ id: LIBRARY_DROP_ID })` registration so
 * `DashboardPage`'s `onDragEnd` can detect "dropped on library" and
 * call `removeWidget(...)`.
 */
function MinimizedPill({ draggingFromGrid }: MinimizedPillProps) {
  const { setNodeRef, isOver } = useDroppable({ id: LIBRARY_DROP_ID })
  return (
    <aside
      ref={setNodeRef}
      className={cn(
        styles.pill,
        isOver && styles.pillActive,
        draggingFromGrid && styles.pillRemove,
      )}
      role="dialog"
      aria-label="Block library — drop zone"
    >
      <span className={styles.pillIcon}>
        <Grid2x22SolidIcon size={14} aria-hidden="true" />
      </span>
      <span className={styles.pillLabel}>
        {draggingFromGrid
          ? (isOver ? 'Drop to put back in library' : 'Library — drop here to remove')
          : 'Drop on grid to add'}
      </span>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Single library item — live widget preview + draggable + click-to-add
// ---------------------------------------------------------------------------

interface LibraryItemProps {
  widget: DashboardWidgetDefinition
  onAdd: (widgetId: string, defaultSize: number) => void
}

function LibraryItem({ widget, onAdd }: LibraryItemProps) {
  // Destructure `useDraggable` so the React Compiler's refs gate doesn't
  // see property accesses on the same object that carries `setNodeRef`.
  // (Reading `.listeners` / `.isDragging` off the umbrella object trips
  // `react-hooks/refs` once `setNodeRef` has been treated as a ref.)
  const {
    setNodeRef,
    listeners,
    attributes,
    isDragging,
  } = useDraggable({ id: `${LIBRARY_DRAG_PREFIX}${widget.id}` })
  const Render = widget.render

  // Preview height in pixels, matching what the same widget will occupy
  // on the dashboard once dropped. The dashboard uses
  //   N rows × GRID_ROW_HEIGHT + (N - 1) × EDITING_GRID_GAP
  // and the library mirrors that exactly so the preview reads as a
  // life-size sample of the destination tile. Width comes from the
  // 12-column CSS grid the library category strip uses — matching the
  // dashboard's `repeat(12, 1fr)` so a `size: 6` widget here is the
  // same pixel width as a `size: 6` widget there.
  const previewHeightPx =
    PREVIEW_DEFAULT_ROWS * GRID_ROW_HEIGHT
    + (PREVIEW_DEFAULT_ROWS - 1) * LIBRARY_GRID_GAP

  // The source element stays put during a drag — dnd-kit's DragOverlay
  // renders the visual at the pointer in a portal, so applying the
  // active drag transform to the source too would produce a duplicated
  // "two cards moving" effect. `.itemDragging` hides the source while
  // the overlay is the only thing the user sees.

  function handleClick() {
    onAdd(widget.id, widget.defaultSize)
  }

  return (
    <div
      className={cn(styles.item, isDragging && styles.itemDragging)}
      style={{ ['--span' as string]: String(widget.defaultSize) }}
      role="group"
      aria-label={`${widget.name} block preview`}
    >
      {/* The clickable preview surface. dnd-kit listeners + click-to-add
          both live here. dnd-kit's `activationConstraint: { distance: 6 }`
          (set on the page-level sensor) means a real click (no drag
          movement) still fires the onClick — pointer-down + pointer-up
          without 6px of movement is a click, not a drag.

          The draggable ref attaches HERE (not on the outer `.item`) so
          dnd-kit's DragOverlay sizes itself to this preview-only area —
          excluding the footer chrome below — and the dragged visual
          matches the size of the destination grid cell exactly.

          BTN-3 §8 exception: this is a structured drag-preview tile sized
          to the widget's natural `defaultSize × default rows` footprint,
          with the widget renderer painting the entire surface. Button's
          inline-flex size tokens (sm = 26px tall, lg = 44px tall) cannot
          represent this custom-sized canvas — same pattern class as §8.5
          (full-surface media tiles) but with dnd-kit drag listeners
          attached. */}
      <button
        ref={(node) => {
          // Callback ref form keeps the ref usage isolated from the
          // surrounding draggable props (matches the DashboardGrid
          // pattern and works around the React Compiler refs gate on
          // object property reads).
          setNodeRef(node)
        }}
        type="button"
        className={styles.itemSurface}
        style={{ height: `${previewHeightPx}px` }}
        onClick={handleClick}
        aria-label={`Add ${widget.name} to dashboard`}
        {...listeners}
        {...attributes}
      >
        <div className={styles.itemPreview} aria-hidden="true">
          {/* Render the widget exactly as it would appear on the
              dashboard. `editing=false` so the preview reads as the
              final tile (no drag-handle, no dashed outline). */}
          <Render span={widget.defaultSize} editing={false} />
        </div>
      </button>
      <footer className={styles.itemFoot}>
        <div className={styles.itemMeta}>
          <span className={styles.itemName}>{widget.name}</span>
          <span className={styles.itemDescription}>{widget.description}</span>
        </div>
        <span className={styles.addHint}>
          <PlusIcon size={10} aria-hidden="true" /> Add
        </span>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Top-edge resize handle
// ---------------------------------------------------------------------------

interface ResizeHandleProps {
  height: number
  onHeightChange: (next: number) => void
}

function ResizeHandle({ height, onHeightChange }: ResizeHandleProps) {
  // Local state for the live drag — keeps the handle smooth without
  // round-tripping through the layout hook on every pointer-move (which
  // would also schedule a debounced server save 60 times per second).
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    dragRef.current = { startY: event.clientY, startHeight: height }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = dragRef.current
    if (!state) return
    // Dragging up grows the panel; dragging down shrinks it. The
    // panel is anchored to the bottom so the visual matches the
    // inverted delta.
    const dy = state.startY - event.clientY
    const next = state.startHeight + dy
    onHeightChange(Math.max(LIBRARY_MIN_HEIGHT, Math.min(LIBRARY_MAX_HEIGHT, next)))
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragRef.current = null
    setDragging(false)
  }

  // Mirror the dragging class onto <body> so the cursor stays as
  // ns-resize even when the pointer briefly leaves the handle during a
  // fast drag. Otherwise the cursor flickers between ns-resize and
  // default.
  useEffect(() => {
    if (!dragging) return
    document.body.style.cursor = 'ns-resize'
    return () => {
      document.body.style.cursor = ''
    }
  }, [dragging])

  return (
    <div
      className={cn(styles.resize, dragging && styles.resizeActive)}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize block library"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <span className={styles.resizeBar} aria-hidden="true" />
    </div>
  )
}
