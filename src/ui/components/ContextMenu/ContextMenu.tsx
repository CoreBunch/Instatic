import {
  useEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@ui/cn'
import {
  type FloatingAlign,
  type FloatingSide,
  type ResolvedFloatingSide,
} from '@ui/lib/floatingPosition'
import { collectSameOriginDocuments, isNode } from '@ui/lib/sameOriginDocuments'
import { useDeferredClose } from './useDeferredClose'
import { useAnchorPosition } from './useAnchorPosition'
import { usePointPosition } from './usePointPosition'
import styles from './ContextMenu.module.css'

interface ContextMenuProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  ariaLabel: string
  onClose: () => void
  children: ReactNode
  /**
   * Optional fixed header rendered above the scrollable content (e.g. a
   * search field). Unlike content passed as `children`, the header does NOT
   * scroll — only the items below it do. Use for searchable dropdowns so the
   * filter box stays put while the list scrolls under it.
   */
  header?: ReactNode
  /**
   * Optional fixed footer rendered below the scrollable content. Does NOT
   * scroll — stays pinned at the bottom of the menu. Use for resize handles
   * or action buttons that must remain reachable.
   */
  footer?: ReactNode
  minWidth?: number
  width?: number
  /**
   * Optional rendered-width ceiling in pixels. Applied after `minWidth` and
   * `matchAnchorWidth`, so wide anchored dropdowns can stay readable without
   * expanding to a long trigger or content-derived width.
   */
  maxWidth?: number
  /**
   * Maximum height of the menu in pixels. When the content exceeds this,
   * the menu becomes vertically scrollable (`overflow-y: auto`). The CSS
   * also clamps the menu to the viewport (`min(maxHeight, 100vh - 16px)`)
   * so very tall menus near a screen edge stay reachable. When omitted the
   * menu is unbounded.
   */
  maxHeight?: number
  zIndex?: number
  menuClassName?: string
  /**
   * Optional element that should be treated as part of the menu for
   * dismiss handling:
   *   - Outside-click detection runs at the document level (mousedown
   *     capture phase) without cancelling the underlying event.
   *   - Clicks inside this trigger element do NOT close the menu — the
   *     trigger keeps receiving native focus and clicks while open.
   *
   * Use this for combobox/dropdown patterns where the trigger is an
   * editable input that must stay focused (e.g. ClassPicker).
   */
  triggerRef?: RefObject<HTMLElement | null>
  /**
   * Absolute viewport-pixel x coordinate of the menu's left edge.
   * Use this together with `y` for point-anchored menus (e.g. right-click).
   * Mutually exclusive with `anchorRef`.
   */
  x?: number
  /** Absolute viewport-pixel y coordinate of the menu's top edge. */
  y?: number
  /**
   * Element whose bounding rect anchors the menu. The menu measures its
   * own size after mount and picks the side with the most available
   * viewport space (auto-flip), behaving the same way as <Tooltip>.
   * Mutually exclusive with `x`/`y`.
   *
   * Position recomputes on window resize and capture-phase scroll while
   * the menu is open, so the menu stays glued to the trigger.
   *
   * `anchorRef` is also used for dismiss handling — clicks inside this
   * element don't close the menu. When `getAnchorRect` is provided, it
   * overrides the rect used for positioning while `anchorRef` continues
   * to gate dismiss-on-outside-click.
   */
  anchorRef?: RefObject<HTMLElement | null>
  /**
   * Optional override for the rect used to position the menu. When
   * provided, the menu uses this rect instead of
   * `anchorRef.current.getBoundingClientRect()` for floating-position
   * math. Use this when the menu's horizontal extent (width / x) and
   * vertical extent (y / opens-below-trigger) need different sources —
   * e.g. a Select whose dropdown spans a wider parent for label
   * visibility but should still open just below the narrow trigger.
   * `anchorRef` is still required (it gates dismiss handling).
   */
  getAnchorRect?: () => DOMRect | null
  /**
   * Preferred side relative to the anchor. `'auto'` tries the priority
   * list `bottom → top → right → left` and picks the first that fits.
   * Default: `'auto'`. Ignored when `anchorRef` is not provided.
   */
  side?: FloatingSide
  /**
   * Cross-axis alignment relative to the anchor. Default: `'start'`
   * (menu's left edge aligns with the anchor's left edge). Ignored when
   * `anchorRef` is not provided.
   */
  align?: FloatingAlign
  /**
   * Gap between anchor edge and menu, in px. Default: 6. Ignored when
   * `anchorRef` is not provided.
   */
  offset?: number
  /**
   * When `true` and `anchorRef` is provided, the menu's rendered width
   * matches the anchor's measured width (clamped to `minWidth` floor).
   * Tracks the anchor live via ResizeObserver so dropdowns stay flush
   * with their trigger when the panel is resized. Use for combobox /
   * input-attached dropdowns (ClassPicker, DynamicBindingControl,
   * SpacingBoxControl) where the dropdown should span the input row.
   */
  matchAnchorWidth?: boolean
  /**
   * When `true`, dismissals (Escape / outside-click) play a brief exit
   * animation before the caller's `onClose` unmounts the menu — the menu
   * stays mounted for one animation window first. Default `false` keeps the
   * instant close that anchored dropdowns (Select, combobox) rely on. Opt in
   * for point-anchored right-click context menus.
   */
  animateExit?: boolean
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<HTMLDivElement>
}

export function ContextMenu({
  ariaLabel,
  onClose,
  children,
  header,
  footer,
  minWidth = 176,
  width = minWidth,
  maxWidth,
  maxHeight,
  zIndex = 1000,
  menuClassName,
  triggerRef,
  x: pointX,
  y: pointY,
  anchorRef,
  getAnchorRect,
  side = 'auto',
  align = 'start',
  offset = 6,
  matchAnchorWidth = false,
  animateExit = false,
  onKeyDown,
  ref,
  ...domProps
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const setMenuRef = (node: HTMLDivElement | null) => {
    menuRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }

  // Exit animation: the menu is presence-mounted by its caller, so it defers
  // `onClose` (the real unmount) by one animation window on dismiss (Escape /
  // outside-click) while `closing` applies the `data-closing` exit keyframes.
  // Item-selection closes go straight through `onClose` (instant), matching
  // the convention that picking an action dismisses the menu immediately.
  // Reopening at a new point/anchor cancels a mid-flight exit.
  const { closing, beginClose } = useDeferredClose(onClose, animateExit, [pointX, pointY, anchorRef])

  // Positioning is delegated to two mutually-exclusive hooks: anchor mode
  // (auto-flip relative to a trigger) and point mode (right-click viewport-fit).
  // `effectiveWidth` flows out of the anchor hook because `matchAnchorWidth`
  // can widen the menu to its trigger; point mode never widens, so the hook
  // returns the plain `width` there.
  const { position: autoPosition, effectiveWidth } = useAnchorPosition({
    anchorRef,
    menuRef,
    getAnchorRect,
    side,
    align,
    offset,
    width,
    minWidth,
    maxWidth: maxWidth != null ? Math.max(maxWidth, minWidth) : undefined,
    maxHeight,
    matchAnchorWidth,
  })
  const { position: pointPosition } = usePointPosition({
    anchorRef,
    menuRef,
    pointX,
    pointY,
    effectiveWidth,
    maxHeight,
  })

  // Resolve the effective x/y the menu renders at:
  //   - anchor mode: use the auto-flipped position (or hide until measured)
  //   - point mode:  use the viewport-clamped position (or hide until measured)
  const resolvedX = anchorRef ? autoPosition?.x : pointPosition?.x
  const resolvedY = anchorRef ? autoPosition?.y : pointPosition?.y
  const resolvedSide: ResolvedFloatingSide | undefined = anchorRef
    ? autoPosition?.side
    : undefined

  // While we measure the menu (either mode), render it off-screen with
  // visibility:hidden so it doesn't flash at (0, 0) before the layout
  // effect runs.
  const measuring = anchorRef
    ? autoPosition === null
    : pointX != null && pointY != null && pointPosition === null

  const style = {
    '--context-menu-x': `${resolvedX ?? 0}px`,
    '--context-menu-y': `${resolvedY ?? 0}px`,
    '--context-menu-min-width': `${minWidth}px`,
    '--context-menu-width': `${effectiveWidth}px`,
    '--context-menu-max-width': maxWidth != null
      ? `${Math.max(maxWidth, minWidth)}px`
      : 'calc(100vw - 16px)',
    '--context-menu-z-index': zIndex,
    ...(maxHeight != null ? { '--context-menu-max-height': `${maxHeight}px` } : null),
    ...(measuring ? { visibility: 'hidden' as const } : null),
  } as CSSProperties

  // Non-modal dismiss: any mouse down / contextmenu outside the menu,
  // explicit triggerRef (if set), and anchor element (if set) closes the
  // menu. The event is not cancelled, so the same click still reaches the
  // element underneath. The anchor is included so anchored dropdowns don't
  // re-close themselves when the user clicks the trigger that just opened
  // them.
  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      const target = event.target
      // Use a cross-realm-safe Node check: events forwarded from an iframe
      // document carry targets from the iframe realm, for which the parent
      // realm's `instanceof Node` is false. `isNode` checks structurally.
      if (!isNode(target)) return
      if (menuRef.current?.contains(target)) return
      if (triggerRef?.current?.contains(target)) return
      if (anchorRef?.current?.contains(target)) return
      beginClose()
    }
    // Attach to the editor document AND every same-origin iframe document
    // (the canvas renders its preview inside per-breakpoint iframes). Without
    // the iframe documents, a click inside the canvas fires on the iframe's
    // own document and never reaches this listener, leaving the menu stuck
    // open until the user clicks the surrounding editor chrome.
    const docs = collectSameOriginDocuments()
    for (const doc of docs) {
      doc.addEventListener('mousedown', handlePointerDown, true)
      doc.addEventListener('contextmenu', handlePointerDown, true)
    }
    return () => {
      for (const doc of docs) {
        doc.removeEventListener('mousedown', handlePointerDown, true)
        doc.removeEventListener('contextmenu', handlePointerDown, true)
      }
    }
  }, [beginClose, triggerRef, anchorRef])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      beginClose()
    }
    onKeyDown?.(event)
  }

  return createPortal(
    <div
      ref={setMenuRef}
      role="menu"
      aria-label={ariaLabel}
      className={cn(styles.menu, menuClassName)}
      data-side={resolvedSide}
      // Entrance keyframes run once the menu is measured and visible;
      // `data-closing` swaps in the exit keyframes during the deferred close.
      data-open={!measuring && !closing ? '' : undefined}
      data-closing={closing ? '' : undefined}
      // With a fixed header, the menu itself is a non-scrolling flex column and
      // the inner content region scrolls; without one, the menu is the scroller.
      data-has-header={header != null ? '' : undefined}
      data-scrollable={header == null && maxHeight != null ? '' : undefined}
      style={style}
      {...domProps}
      onKeyDown={handleKeyDown}
      onClick={(event) => { event.stopPropagation(); domProps.onClick?.(event) }}
    >
      {header != null ? (
        <>
          <div className={styles.menuHeader}>{header}</div>
          <div
            className={styles.menuScroll}
            data-scrollable={maxHeight != null ? '' : undefined}
          >
            {children}
          </div>
          {footer}
        </>
      ) : (
        <>
          {children}
          {footer}
        </>
      )}
    </div>,
    document.body,
  )
}
