/**
 * DashboardGrid — 12-column / fixed-row-height widget grid with explicit
 * per-cell placement and free-position drag-and-drop.
 *
 * Layout model
 * ------------
 * Each `DashboardItem` carries `{ col, row, size, rows }` — explicit grid
 * coordinates. The CSS sets `grid-column: col / span size` and
 * `grid-row: row / span rows` on every cell, so widgets stay exactly
 * where the user puts them. The grid does NOT use `grid-auto-flow` —
 * gaps between widgets are honoured.
 *
 * Drag-to-move + drag-from-library
 * --------------------------------
 * One grid-wide droppable instead of per-cell drop zones. The parent
 * `DashboardPage` owns the `DndContext` (so the Block library can sit
 * outside this component as a sibling drag source) — this component just
 * registers the grid surface as the single drop target via
 * `GRID_DROP_ID` and re-exports the snap-math helpers used by the page's
 * `onDragEnd` handler.
 *
 * Resize
 * ------
 * Same per-side handle model as before (left / right / top / bottom +
 * corner). The hook applies collision resolution after each resize so
 * neighbouring cards slide down to make room.
 *
 * Resize / move snap math (column width, row height) is mirrored from
 * `useDashboardLayout.ts` so the JS handlers and CSS grid track sizes
 * stay in lockstep.
 */
import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import {
  useDraggable,
  useDroppable,
} from '@dnd-kit/core'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import type { DashboardWidgetDefinition } from '@core/dashboard'
import { Button } from '@ui/components/Button'
import { WidgetSkeleton } from '@ui/components/Widget'
import { cn } from '@ui/cn'
import {
  EDITING_GRID_GAP,
  GRID_DROP_ID,
  GRID_ROW_HEIGHT,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  type DashboardItem,
} from '../hooks/useDashboardLayout'

/**
 * Extra empty rows reserved below the lowest widget while in customize
 * mode. Without this the grid surface sizes itself to the content and
 * leaves no droppable area for a library tile to land in. Six rows of
 * room is enough to drop any widget (largest first-party widget is 5
 * rows tall) plus visual margin.
 */
const CUSTOMIZE_DROPZONE_ROWS = 6
import styles from './DashboardGrid.module.css'

function clampSize(size: number, min: number, max: number): number {
  if (size < min) return min
  if (size > max) return max
  return Math.round(size)
}

interface DashboardGridProps {
  items: readonly DashboardItem[]
  /** Definitions keyed by id (registry snapshot). */
  definitions: ReadonlyMap<string, DashboardWidgetDefinition>
  editing: boolean
  onResize: (id: string, size: number) => void
  onResizeRows: (id: string, rows: number) => void
  onAddBlock: () => void
  /**
   * Imperative ref to the grid's DOM root. The page uses it to read
   * `getBoundingClientRect()` during `onDragEnd` so it can snap library
   * drops to a grid cell.
   */
  gridRef: React.RefObject<HTMLDivElement | null>
  /**
   * Live drop-target preview during an active drag. The grid renders a
   * translucent placeholder at the pixel rectangle described by
   * `leftPx` / `topPx` / `widthPx` / `heightPx`. CSS transitions on
   * those properties make the ghost glide smoothly between cells as
   * the pointer crosses cell boundaries. `null` whenever no drag is
   * in progress, the pointer left the grid (e.g. is over the library
   * drop pill), OR the proposed destination would overlap an existing
   * widget (drops only land in empty space).
   */
  dropTarget:
    | {
        col: number
        row: number
        size: number
        rows: number
        leftPx: number
        topPx: number
        widthPx: number
        heightPx: number
      }
    | null
}

export function DashboardGrid({
  items,
  definitions,
  editing,
  onResize,
  onResizeRows,
  onAddBlock,
  gridRef,
  dropTarget,
}: DashboardGridProps) {
  /**
   * The "Add block" tile sits in the next row below the lowest widget.
   * We compute it from the max (row + rows) of the items so dropping a
   * widget further down doesn't leave the Add tile stranded mid-grid.
   */
  const addBlockRow = items.reduce(
    (max, item) => Math.max(max, item.row + item.rows),
    1,
  )

  // While editing, force the grid to extend several rows BELOW the
  // lowest widget so the user has actual empty cells to drag library
  // tiles into. Computed in pixels (row-height + the customize-mode
  // gap × rows). View mode leaves min-height unset so the grid stays
  // tight to its content.
  const dropZoneBottomRow = addBlockRow + CUSTOMIZE_DROPZONE_ROWS
  const gridMinHeight = editing
    ? dropZoneBottomRow * (GRID_ROW_HEIGHT + EDITING_GRID_GAP)
    : undefined

  // CRITICAL: a SINGLE render tree across view/customize so the grid's
  // root <div> survives the mode flip with the same DOM identity. If we
  // returned different JSX trees for the two modes, React would unmount
  // the old grid element and mount a fresh one — and a brand-new element
  // has no previous CSS state for the `gap` transition to interpolate
  // from. The transition would silently no-op.
  //
  // Inside, each cell branches per-mode: `<DraggableCell>` in customize,
  // a plain `<div>` in view. The Add-block tile renders only in customize.
  // The grid surface itself stays the same element.
  return (
    <GridSurface ref={gridRef} editing={editing} minHeight={gridMinHeight}>
      {items.map((item) => {
        const def = definitions.get(item.id)
        // Definition not yet registered (typical for plugin-registered
        // widgets that activate after first paint). Render a
        // `<WidgetSkeleton>` placeholder in the slot so the grid keeps
        // its exact `col / row / size / rows` footprint and the cell
        // reads as "loading" instead of an empty hole. When the
        // plugin's `activate()` hook runs and registers the widget,
        // the real renderer swaps in with zero layout shift.
        //
        // Customize mode skips the placeholder — dragging an
        // unregistered slot is meaningless until the widget itself is
        // available — but we still render the cell wrapper so the
        // layout footprint stays.
        if (!def) {
          return (
            <div
              key={item.id}
              className={styles.cell}
              data-span={item.size}
              data-rows={item.rows}
              data-col={item.col}
              data-row={item.row}
              style={{
                ['--span' as string]: String(item.size),
                ['--rows' as string]: String(item.rows),
                ['--col' as string]: String(item.col),
                ['--row' as string]: String(item.row),
              }}
            >
              <WidgetSkeleton widgetId={item.id} span={item.size} />
            </div>
          )
        }
        if (editing) {
          return (
            <DraggableCell
              key={item.id}
              item={item}
              definition={def}
              onResize={onResize}
              onResizeRows={onResizeRows}
            />
          )
        }
        const Render = def.render
        return (
          <div
            key={item.id}
            className={styles.cell}
            data-span={item.size}
            data-rows={item.rows}
            data-col={item.col}
            data-row={item.row}
            style={{
              ['--span' as string]: String(item.size),
              ['--rows' as string]: String(item.rows),
              ['--col' as string]: String(item.col),
              ['--row' as string]: String(item.row),
            }}
          >
            <Render span={item.size} editing={false} />
          </div>
        )
      })}
      {editing && (
        <Button
          variant="ghost"
          className={cn(styles.cell, styles.addWidget)}
          data-span={3}
          data-rows={3}
          data-col={1}
          data-row={addBlockRow}
          style={{
            ['--span' as string]: '3',
            ['--rows' as string]: '3',
            ['--col' as string]: '1',
            ['--row' as string]: String(addBlockRow),
          }}
          onClick={onAddBlock}
        >
          <span className={styles.addInner}>
            <span className={styles.addIcon}>
              <PlusIcon size={14} />
            </span>
            <span className={styles.addLabel}>Add block</span>
          </span>
        </Button>
      )}
      {/* Live drop-target preview, absolutely positioned inside the
          grid surface. CSS transitions on `top` / `left` / `width` /
          `height` (see `.dropPreview` in DashboardGrid.module.css)
          make the placeholder glide smoothly from one cell to the
          next as the pointer crosses cell boundaries — `grid-column-
          start` / `grid-row-start` aren't transitionable in all
          browsers, so we feed pixel coordinates from `DashboardPage`'s
          `onDragMove` math instead. Pointer-events disabled so the
          placeholder never absorbs drop events itself. */}
      {dropTarget && (
        <div
          className={styles.dropPreview}
          aria-hidden="true"
          data-span={dropTarget.size}
          data-rows={dropTarget.rows}
          data-col={dropTarget.col}
          data-row={dropTarget.row}
          style={{
            left: `${dropTarget.leftPx}px`,
            top: `${dropTarget.topPx}px`,
            width: `${dropTarget.widthPx}px`,
            height: `${dropTarget.heightPx}px`,
          }}
        />
      )}
    </GridSurface>
  )
}

/**
 * Grid surface — registers itself as a single droppable so dnd-kit fires
 * `onDragEnd` regardless of which cell the user releases over. Forwards
 * its DOM node to both the parent ref (for snap-math measurements) and
 * the droppable's setNodeRef.
 *
 * Stays mounted across view/customize toggles — the `.editing` class
 * just gets added/removed on the same DOM node so the CSS `gap` /
 * `outline-color` transitions have a previous state to interpolate
 * from. Without this stability the gap change would snap instantly
 * because the element would be brand-new each toggle.
 */
function GridSurface({
  ref,
  editing,
  minHeight,
  children,
}: {
  ref: React.RefObject<HTMLDivElement | null>
  editing: boolean
  minHeight: number | undefined
  children: React.ReactNode
}) {
  const { setNodeRef } = useDroppable({ id: GRID_DROP_ID })

  function setRefs(node: HTMLDivElement | null) {
    ref.current = node
    setNodeRef(node)
  }

  return (
    <div
      ref={setRefs}
      className={cn(styles.gridLayout, editing && styles.editing)}
      // `min-height` is only set in customize mode — the empty rows
      // below the lowest widget exist purely to give library tiles
      // a place to land. The number comes from `gridMinHeight` in
      // the parent, which mirrors `CUSTOMIZE_DROPZONE_ROWS` extra
      // rows worth of pixels.
      style={
        minHeight !== undefined
          ? { ['--grid-min-height' as string]: `${minHeight}px` }
          : undefined
      }
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Draggable cell + resize handles
// ---------------------------------------------------------------------------

type ResizeAxis = 'x' | 'y' | 'xy'
type ResizeKind = 'left' | 'right' | 'top' | 'bottom' | 'corner'

interface ResizeSpec {
  kind: ResizeKind
  axis: ResizeAxis
  xSign: -1 | 0 | 1
  ySign: -1 | 0 | 1
}

const RESIZE_SPECS: Record<ResizeKind, ResizeSpec> = {
  right:  { kind: 'right',  axis: 'x',  xSign:  1, ySign:  0 },
  left:   { kind: 'left',   axis: 'x',  xSign: -1, ySign:  0 },
  bottom: { kind: 'bottom', axis: 'y',  xSign:  0, ySign:  1 },
  top:    { kind: 'top',    axis: 'y',  xSign:  0, ySign: -1 },
  corner: { kind: 'corner', axis: 'xy', xSign:  1, ySign:  1 },
}

interface DraggableCellProps {
  item: DashboardItem
  definition: DashboardWidgetDefinition
  onResize: (id: string, size: number) => void
  onResizeRows: (id: string, rows: number) => void
}

function DraggableCell({ item, definition, onResize, onResizeRows }: DraggableCellProps) {
  const draggable = useDraggable({ id: item.id })
  const Render = definition.render

  const containerRef = useRef<HTMLDivElement | null>(null)
  const resizeStateRef = useRef<{
    spec: ResizeSpec
    startX: number
    startY: number
    startSize: number
    startRows: number
    colWidth: number
    rowHeight: number
  } | null>(null)

  function startResize(spec: ResizeSpec, event: ReactPointerEvent<HTMLSpanElement>) {
    event.stopPropagation()
    event.preventDefault()

    const container = containerRef.current
    const grid = container?.parentElement
    if (!container || !grid) return

    const gridRect = grid.getBoundingClientRect()
    // Same reasoning as the move snap math: resize only fires in
    // customize mode, so use the wider gutter constant the rendered
    // grid actually uses. One full column step = column-track +
    // gap; one row step = row-height + gap.
    const colWidth = (gridRect.width - (MAX_COLS - 1) * EDITING_GRID_GAP) / MAX_COLS + EDITING_GRID_GAP
    if (colWidth <= 0) return

    resizeStateRef.current = {
      spec,
      startX: event.clientX,
      startY: event.clientY,
      startSize: item.size,
      startRows: item.rows,
      colWidth,
      rowHeight: GRID_ROW_HEIGHT + EDITING_GRID_GAP,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveResize(event: ReactPointerEvent<HTMLSpanElement>) {
    const state = resizeStateRef.current
    if (!state) return

    const { spec, startX, startY, startSize, startRows, colWidth, rowHeight } = state

    if (spec.axis === 'x' || spec.axis === 'xy') {
      const dx = event.clientX - startX
      const cols = Math.round(dx / colWidth) * spec.xSign
      const nextSize = clampSize(startSize + cols, MIN_COLS, MAX_COLS)
      if (nextSize !== item.size) onResize(item.id, nextSize)
    }
    if (spec.axis === 'y' || spec.axis === 'xy') {
      const dy = event.clientY - startY
      const rows = Math.round(dy / rowHeight) * spec.ySign
      const nextRows = clampSize(startRows + rows, MIN_ROWS, MAX_ROWS)
      if (nextRows !== item.rows) onResizeRows(item.id, nextRows)
    }
  }

  function endResize(event: ReactPointerEvent<HTMLSpanElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    resizeStateRef.current = null
  }

  const transformStyle = draggable.transform
    ? `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)`
    : undefined

  return (
    <div
      ref={(node) => {
        containerRef.current = node
        draggable.setNodeRef(node)
      }}
      className={cn(
        styles.cell,
        draggable.isDragging && styles.dragging,
      )}
      data-span={item.size}
      data-rows={item.rows}
      data-col={item.col}
      data-row={item.row}
      style={{
        ['--span' as string]: String(item.size),
        ['--rows' as string]: String(item.rows),
        ['--col' as string]: String(item.col),
        ['--row' as string]: String(item.row),
        transform: transformStyle,
      }}
      {...draggable.listeners}
      {...draggable.attributes}
    >
      <Render span={item.size} editing />

      {/* 4 edge handles + 1 corner handle. The corner is stacked above
          the edges (z-index: 11 vs 10) so the small overlap area
          resolves to two-axis resize. */}
      <ResizeHandle
        kind="left"
        label={`Resize ${definition.name} from left`}
        onStart={startResize}
        onMove={moveResize}
        onEnd={endResize}
      />
      <ResizeHandle
        kind="right"
        label={`Resize ${definition.name} from right`}
        onStart={startResize}
        onMove={moveResize}
        onEnd={endResize}
      />
      <ResizeHandle
        kind="top"
        label={`Resize ${definition.name} from top`}
        onStart={startResize}
        onMove={moveResize}
        onEnd={endResize}
      />
      <ResizeHandle
        kind="bottom"
        label={`Resize ${definition.name} from bottom`}
        onStart={startResize}
        onMove={moveResize}
        onEnd={endResize}
      />
      <ResizeHandle
        kind="corner"
        label={`Resize ${definition.name} from corner`}
        onStart={startResize}
        onMove={moveResize}
        onEnd={endResize}
      />
    </div>
  )
}

interface ResizeHandleProps {
  kind: ResizeKind
  label: string
  onStart: (spec: ResizeSpec, event: ReactPointerEvent<HTMLSpanElement>) => void
  onMove: (event: ReactPointerEvent<HTMLSpanElement>) => void
  onEnd: (event: ReactPointerEvent<HTMLSpanElement>) => void
}

const HANDLE_CLASS: Record<ResizeKind, string> = {
  left: styles.handleLeft as string,
  right: styles.handleRight as string,
  top: styles.handleTop as string,
  bottom: styles.handleBottom as string,
  corner: styles.handleCorner as string,
}

function ResizeHandle({ kind, label, onStart, onMove, onEnd }: ResizeHandleProps) {
  const spec = RESIZE_SPECS[kind]
  return (
    <span
      className={cn(styles.handle, HANDLE_CLASS[kind])}
      role="separator"
      aria-orientation={spec.axis === 'y' ? 'horizontal' : 'vertical'}
      aria-label={label}
      onPointerDown={(e) => onStart(spec, e)}
      onPointerMove={onMove}
      onPointerUp={onEnd}
      onPointerCancel={onEnd}
      onClick={(e) => e.stopPropagation()}
    />
  )
}
