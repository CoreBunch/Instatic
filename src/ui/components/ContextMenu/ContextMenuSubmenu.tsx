import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { cn } from '@ui/cn'
import {
  computeFloatingPosition,
  type ResolvedFloatingSide,
} from '@ui/lib/floatingPosition'
import { ContextMenuSubmenuContext } from './ContextMenuSubmenuContext'
import styles from './ContextMenu.module.css'

interface ContextMenuSubmenuProps {
  /** Trigger label — displayed on the submenu row */
  label: ReactNode
  /** Optional icon shown to the left of the label (use pixel-art-icons) */
  icon?: ReactNode
  /**
   * Called after a submenu item is clicked — typically the parent menu's
   * `onClose` handler so the entire menu closes when an item is selected.
   */
  onClose?: () => void
  /** Submenu items — typically `ContextMenuItem` elements */
  children: ReactNode
  /** z-index base for the submenu panel (submenu uses zIndex + 10). Default: 1000 */
  zIndex?: number
  /** Submenu panel width in px. Default: 176. */
  width?: number
  /** Submenu panel min-width in px. Default: same as `width`. */
  minWidth?: number
  /**
   * Maximum height of the submenu panel in px. When set, the panel scrolls
   * vertically (`overflow-y: auto`) and the height is clamped to
   * `min(maxHeight, 100vh - 16px)` so it never overflows the viewport. Use
   * for searchable submenus with long item lists.
   */
  maxHeight?: number
  /**
   * When true, panel-level clicks DO NOT auto-close the submenu — only clicks
   * on a `[role="menuitem"]` descendant (or its children) close it. Use this
   * for searchable submenus that contain non-menuitem widgets (e.g. a search
   * input) where clicking the input must not dismiss the menu.
   *
   * Default: false (legacy behavior — any click inside the submenu closes).
   */
  closeOnItemClickOnly?: boolean
}

/** Submenu side priority — prefer right, flip to left when it doesn't fit. */
const SUBMENU_AUTO_PRIORITY = ['right', 'left'] as const

/**
 * Nested submenu trigger for ContextMenu.
 *
 * Renders a trigger row (role="menuitem") with a trailing chevron. Hovering
 * or pressing ArrowRight opens a positioned submenu panel to the right.
 * ArrowLeft or Escape closes the submenu without closing the parent menu.
 * Clicking a submenu item calls `onClose` (if provided) to close the parent.
 *
 * Usage:
 * ```tsx
 * <ContextMenuSubmenu label="Insert here" icon={<PlusIcon size={12} />} onClose={close}>
 *   <ContextMenuItem onClick={...}>Item A</ContextMenuItem>
 * </ContextMenuSubmenu>
 * ```
 */
export function ContextMenuSubmenu({
  label,
  icon,
  onClose,
  children,
  zIndex = 1000,
  width = 176,
  minWidth,
  maxHeight,
  closeOnItemClickOnly = false,
}: ContextMenuSubmenuProps) {
  const [open, setOpen] = useState(false)
  // Position is `null` until the submenu has been measured (one
  // useLayoutEffect tick after mount). While `null`, the panel renders with
  // `visibility: hidden` so it doesn't flash at (0, 0).
  const [position, setPosition] = useState<{
    x: number
    y: number
    side: ResolvedFloatingSide
  } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const ownerPanels = useContext(ContextMenuSubmenuContext)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const resolvedMinWidth = minWidth ?? width

  useLayoutEffect(() => {
    const panel = submenuRef.current
    const panels = ownerPanels?.current
    if (!open || !panel || !panels) return
    panels.add(panel)
    return () => { panels.delete(panel) }
  }, [open, ownerPanels])

  // Measure trigger + submenu and pick the side with the most space.
  // Mirrors the ContextMenu (anchored mode) and Tooltip auto-flip strategy
  // — `computeFloatingPosition` tries `right` first, then `left`, and
  // clamps to the viewport so the panel never overflows the screen edge.
  // useCallback kept: stable identity for the useLayoutEffect/useEffect dep arrays;
  // without it the position effects loop every render (exhaustive-deps misses this
  // because the dep IS listed, not missing — the test runner doesn't use the compiler).
  const recomputePosition = useCallback(() => {
    const triggerEl = triggerRef.current
    const menuEl = submenuRef.current
    if (!triggerEl || !menuEl) return
    const triggerRect = triggerEl.getBoundingClientRect()
    const menuRect = menuEl.getBoundingClientRect()
    // When `maxHeight` is set, the rendered rect already reflects the cap
    // (CSS `max-height` is applied before getBoundingClientRect). Defensively
    // clamp here too so position math agrees with the rendered size on the
    // very first measurement.
    const effectiveHeight = maxHeight != null
      ? Math.min(menuRect.height, maxHeight)
      : menuRect.height
    const next = computeFloatingPosition(triggerRect, {
      floatingWidth: width,
      floatingHeight: effectiveHeight,
      side: 'auto',
      align: 'start',
      offset: 2,
      autoPriority: SUBMENU_AUTO_PRIORITY,
    })
    setPosition({ x: next.x, y: next.y, side: next.side })
  }, [maxHeight, width])

  // Measure on open. useLayoutEffect runs synchronously after the panel
  // mounts, so the user never sees the unmeasured (0, 0) frame.
  // No-op when closed — the panel isn't in the DOM, and `position` is
  // inherently a property of "the open submenu", so dropping a stale value
  // on close is unnecessary (the next open re-measures and overwrites).
  useLayoutEffect(() => {
    if (!open) return
    recomputePosition()
  }, [open, recomputePosition])

  // Recompute on viewport changes while open — same pattern as ContextMenu.
  useEffect(() => {
    if (!open) return
    function onViewportChange() {
      recomputePosition()
    }
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [open, recomputePosition])

  // Open submenu: show panel, auto-focus first item via rAF (rAF runs AFTER
  // the layout effect, so the panel is already positioned).
  function openSubmenu() {
    setOpen(true)
    requestAnimationFrame(() => {
      const first = submenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
      first?.focus()
    })
  }

  // Schedule a delayed close — cancelled if mouse re-enters trigger or submenu.
  function scheduleClose() {
    closeTimerRef.current = setTimeout(() => {
      setOpen(false)
      closeTimerRef.current = null
    }, 100)
  }

  function cancelClose() {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  function handleTriggerClick() {
    if (open) {
      setOpen(false)
    } else {
      openSubmenu()
    }
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      openSubmenu()
    }
  }

  function handleSubmenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'Escape') {
      // Close submenu only — stop propagation so parent ContextMenu's
      // Escape handler does NOT fire (closing submenu ≠ closing parent).
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const items = [
        ...(submenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
      ]
      const currentIndex = items.indexOf(document.activeElement as HTMLElement)
      const next = currentIndex + (event.key === 'ArrowDown' ? 1 : -1)
      if (next >= 0 && next < items.length) {
        items[next].focus()
      }
    }
  }

  // Default: any click inside the submenu panel closes both submenu and parent.
  // When `closeOnItemClickOnly` is set, ignore clicks that don't land on (or
  // inside) a `[role="menuitem"]` — useful for searchable submenus where the
  // panel hosts non-menuitem widgets like a search input.
  function handleSubmenuClick(event: React.MouseEvent<HTMLDivElement>) {
    if (closeOnItemClickOnly) {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (!target.closest('[role="menuitem"]')) return
    }
    setOpen(false)
    onClose?.()
  }

  return (
    <div className={styles.submenuRoot}>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="xs"
        menuItem
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        fullWidth
        align="between"
        className={cn(styles.item, styles.submenuTrigger)}
        onMouseEnter={() => {
          cancelClose()
          openSubmenu()
        }}
        onMouseLeave={scheduleClose}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className={styles.submenuTriggerContent}>
          {icon && <span aria-hidden="true">{icon}</span>}
          {label}
        </span>
        <span aria-hidden="true" className={styles.submenuChevron}>
          <ChevronRightIcon size={10} color="currentColor" />
        </span>
      </Button>
      {open && typeof document !== 'undefined' && createPortal(
        // The panel is portaled to document.body so its viewport-pixel
        // positioning (set via CSS custom properties on `style`) escapes
        // any `overflow: hidden` / `transform` / `contain` ancestor that
        // would otherwise clip or re-anchor it. The DOM-tree relationship
        // between trigger and panel is unchanged for accessibility — the
        // ARIA wiring lives on attributes (aria-haspopup / role="menu"),
        // not the DOM hierarchy.
        //
        // While `position` is null we render with `visibility: hidden` so
        // the panel doesn't flash at (0, 0) before the layout effect has
        // measured it — same trick as the anchored ContextMenu mode.
        <div
          ref={submenuRef}
          role="menu"
          aria-label={typeof label === 'string' ? label : undefined}
          className={styles.menu}
          data-scrollable={maxHeight != null ? '' : undefined}
          data-side={position?.side}
          // Play the entrance keyframes once the panel is measured and shown.
          data-open={position !== null ? '' : undefined}
          style={{
            '--context-menu-x': `${position?.x ?? 0}px`,
            '--context-menu-y': `${position?.y ?? 0}px`,
            '--context-menu-z-index': zIndex + 10,
            '--context-menu-min-width': `${resolvedMinWidth}px`,
            '--context-menu-width': `${width}px`,
            '--context-menu-max-width': 'calc(100vw - 16px)',
            ...(maxHeight != null
              ? { '--context-menu-max-height': `${maxHeight}px` }
              : null),
            ...(position === null ? { visibility: 'hidden' as const } : null),
          } as CSSProperties}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onKeyDown={handleSubmenuKeyDown}
          onClick={handleSubmenuClick}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  )
}
