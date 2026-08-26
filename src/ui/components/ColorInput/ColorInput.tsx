/**
 * ColorInput — the swatch control every colour field in the editor renders.
 *
 * The swatch is a trigger: activating it opens the rich {@link ColorPicker} in
 * a portalled floating panel. The panel opens to the LEFT of the trigger (the
 * triggers live in the right-hand properties sidebar, so the panel lands
 * beside the panel over the canvas) and has a drag header so the user can
 * move it anywhere. It closes from its × button, Escape, re-activating the
 * trigger, or any pointerdown outside it — which also guarantees at most one
 * panel is ever open.
 *
 * Read-only swatches (`disabled`) render the preview alone and never open.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import {
  ColorPicker,
  formatGradient,
  parseGradient,
  safeCssColor,
  type ColorPickerToken,
} from '@ui/components/ColorPicker'
import styles from './ColorInput.module.css'

type ColorInputSize = 'xs' | 'sm' | 'md'

interface ColorInputProps {
  id?: string
  className?: string
  style?: CSSProperties
  fieldSize?: ColorInputSize
  disabled?: boolean
  /** Current value (`#rrggbb`, `rgb(...)`, `hsl(...)`, `var(--token)`, or a gradient). */
  value: string
  /** Optional preview override — use when `value` is a reference to resolve. */
  swatchValue?: string
  'aria-label'?: string
  /** Fires with the picked colour. Omit (or pass `disabled`) for preview-only swatches. */
  onValueChange?: (value: string) => void
  /** Offer the picker's Solid / Linear / Radial fill tabs. */
  gradients?: boolean
  /** Site colour tokens shown in the picker's searchable list. */
  tokens?: readonly ColorPickerToken[]
  /** Fires when a token row is picked, with its `var(--name)` reference. */
  onSelectToken?: (reference: string) => void
  /** Enables the picker's "New Style" action. */
  onCreateToken?: (name: string, value: string) => void
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<HTMLButtonElement>
}

type ColorInputStyle = CSSProperties & {
  '--color-input-value'?: string
  '--color-input-image'?: string
  '--color-picker-anchor-x'?: string
  '--color-picker-anchor-y'?: string
}

/** Panel gap from the trigger, and the viewport margin it is clamped to. */
const POPOVER_GAP = 8
const VIEWPORT_MARGIN = 8
const POPOVER_WIDTH = 244
const POPOVER_HEIGHT = 470

/** Fraction of the into-obstacle overshoot the panel follows while dragged. */
const OBSTACLE_RESISTANCE = 0.25

export function ColorInput({
  id,
  className,
  style,
  fieldSize = 'sm',
  disabled = false,
  value,
  swatchValue,
  'aria-label': ariaLabel,
  onValueChange,
  gradients = false,
  tokens,
  onSelectToken,
  onCreateToken,
  ref,
}: ColorInputProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const interactive = !disabled && onValueChange != null
  const open = position !== null

  /** Re-place with the panel's REAL size and clear of any marked obstacle. */
  function settle(x: number, y: number): { x: number; y: number } {
    const panel = popoverRef.current
    const width = panel?.offsetWidth ?? POPOVER_WIDTH
    const height = panel?.offsetHeight ?? POPOVER_HEIGHT
    return avoidObstacles(clampPosition(x, y, width, height), width, height)
  }

  // Once the panel has rendered its actual content (token list, gradient
  // strip, ...) its height is known — re-clamp so it opens fully on screen
  // and clear of the sidebars, instead of trusting the height guess.
  // Positioning against the DOM is exactly what a layout effect is for; the
  // setState inside is the re-placement itself.
  /* eslint-disable react-hooks/set-state-in-effect */
  useLayoutEffect(() => {
    if (!open) return
    setPosition((current) => (current ? settle(current.x, current.y) : current))
  }, [open])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Dismissal: ×, Escape, or a pointerdown outside the panel and trigger.
  // The outside-close is what keeps a single panel alive at a time (pressing
  // another swatch, or opening the media picker, closes this one first) —
  // and it cannot fire mid-palette-use: clicks inside the panel are ignored,
  // and the native EyeDropper overlay never dispatches document pointerdowns.
  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setPosition(null)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setPosition(null)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open])

  function toggle() {
    if (!interactive) return
    if (open) {
      setPosition(null)
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setPosition(placeBesideTrigger(rect))
  }

  /**
   * Header drag: window-level listeners (not pointer capture on the header)
   * so the panel keeps following even when the pointer crosses an iframe-free
   * region fast. Offsets are captured once at press time.
   *
   * Performance: pointer moves write the anchor custom properties STRAIGHT
   * onto the panel element — zero React renders per move, so the panel sticks
   * to the cursor no matter how heavy the picker's subtree is. React state is
   * reconciled once, at drag end.
   *
   * Boundary handling is soft: dragging past the viewport edge or INTO a
   * sidebar rubber-bands (the panel follows only a fraction of the
   * overshoot), and on release it glides back to the allowed spot — the
   * `.dragging` class suppresses the position transition so only the release
   * animates, never the pointer-following.
   */
  function beginPanelDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const panel = popoverRef.current
    if (position === null || !panel) return
    // The × button lives in the header — don't let its press start a drag.
    if (event.target instanceof Element && event.target.closest('button')) return
    event.preventDefault()
    setDragging(true)
    panel.classList.add(styles.dragging)
    const offsetX = event.clientX - position.x
    const offsetY = event.clientY - position.y
    // Sizes and obstacle rects are stable for the duration of one drag —
    // measure once, not per pointer move.
    const width = panel.offsetWidth
    const height = panel.offsetHeight
    const obstacles = measureObstacles()
    let last = position

    const applyVars = (pos: { x: number; y: number }) => {
      panel.style.setProperty('--color-picker-anchor-x', `${pos.x}px`)
      panel.style.setProperty('--color-picker-anchor-y', `${pos.y}px`)
    }

    const handleMove = (move: PointerEvent) => {
      const raw = { x: move.clientX - offsetX, y: move.clientY - offsetY }
      const allowed = avoidObstacles(
        clampPosition(raw.x, raw.y, width, height),
        width,
        height,
        obstacles,
      )
      last = {
        x: allowed.x + (raw.x - allowed.x) * OBSTACLE_RESISTANCE,
        y: allowed.y + (raw.y - allowed.y) * OBSTACLE_RESISTANCE,
      }
      applyVars(last)
    }
    const handleEnd = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
      // Re-enable the transition synchronously so the glide-back below
      // animates without waiting for the React re-render.
      panel.classList.remove(styles.dragging)
      const settled = avoidObstacles(
        clampPosition(last.x, last.y, width, height),
        width,
        height,
        obstacles,
      )
      applyVars(settled)
      setDragging(false)
      setPosition(settled)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
  }

  const preview = swatchValue ?? value
  const previewGradient = parseGradient(preview)
  const frameStyle: ColorInputStyle = previewGradient
    ? { ...style, '--color-input-image': formatGradient(previewGradient, 'hex') }
    : { ...style, '--color-input-value': safeCssColor(preview) }

  return (
    <>
      <button
        id={id}
        type="button"
        ref={mergeRefs(triggerRef, ref)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={interactive ? open : undefined}
        className={cn(
          styles.colorInput,
          styles[`size-${fieldSize}`],
          disabled && styles.disabled,
          className,
        )}
        style={frameStyle}
        onClick={toggle}
      >
        <span className={styles.preview} aria-hidden="true" />
      </button>
      {position !== null && onValueChange && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={ariaLabel ? `${ariaLabel} picker` : 'Colour picker'}
            className={cn(styles.popover, dragging && styles.dragging)}
            style={
              {
                '--color-picker-anchor-x': `${position.x}px`,
                '--color-picker-anchor-y': `${position.y}px`,
              } as ColorInputStyle
            }
          >
            <div className={styles.popoverHeader} onPointerDown={beginPanelDrag}>
              <span className={styles.popoverTitle}>{ariaLabel ?? 'Fill'}</span>
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                aria-label="Close colour picker"
                onClick={() => setPosition(null)}
              >
                <CloseIcon size={10} aria-hidden="true" />
              </Button>
            </div>
            <ColorPicker
              value={value}
              onChange={onValueChange}
              gradients={gradients}
              tokens={tokens}
              onSelectToken={onSelectToken}
              onCreateToken={onCreateToken}
            />
          </div>,
          document.body,
        )}
    </>
  )
}

/**
 * Prefer the slot LEFT of the trigger — the triggers sit in the right-hand
 * properties sidebar, so this floats the panel beside the sidebar, over the
 * canvas (the layout effect then re-settles it against the measured size and
 * the marked obstacles). Falls back to under the trigger when there is no
 * room on the left.
 */
function placeBesideTrigger(rect: DOMRect): { x: number; y: number } {
  const left = rect.left - POPOVER_WIDTH - POPOVER_GAP
  if (left >= VIEWPORT_MARGIN) return clampPosition(left, rect.top, POPOVER_WIDTH, POPOVER_HEIGHT)
  return clampPosition(rect.left, rect.bottom + POPOVER_GAP, POPOVER_WIDTH, POPOVER_HEIGHT)
}

function clampPosition(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const maxX = window.innerWidth - width - VIEWPORT_MARGIN
  const maxY = window.innerHeight - height - VIEWPORT_MARGIN
  return {
    x: Math.max(VIEWPORT_MARGIN, Math.min(x, maxX)),
    y: Math.max(VIEWPORT_MARGIN, Math.min(y, maxY)),
  }
}

/** Measure every `data-floating-obstacle` element's current rect. */
function measureObstacles(): DOMRect[] {
  const rects: DOMRect[] = []
  for (const element of document.querySelectorAll('[data-floating-obstacle]')) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) rects.push(rect)
  }
  return rects
}

/**
 * Keep the panel off elements marked `data-floating-obstacle` (the editor
 * marks its sidebars): when the panel intersects one, it is pushed
 * horizontally toward the canvas — left of a right-side obstacle, right of a
 * left-side one — then re-clamped to the viewport.
 */
function avoidObstacles(
  pos: { x: number; y: number },
  width: number,
  height: number,
  obstacles: readonly DOMRect[] = measureObstacles(),
): { x: number; y: number } {
  let { x } = pos
  const { y } = pos
  for (const rect of obstacles) {
    const intersects =
      x < rect.right && x + width > rect.left && y < rect.bottom && y + height > rect.top
    if (!intersects) continue
    x = rect.left + rect.width / 2 > window.innerWidth / 2
      ? rect.left - width - POPOVER_GAP
      : rect.right + POPOVER_GAP
  }
  return clampPosition(x, y, width, height)
}

function mergeRefs(
  local: { current: HTMLButtonElement | null },
  forwarded: Ref<HTMLButtonElement> | undefined,
) {
  return (node: HTMLButtonElement | null) => {
    local.current = node
    if (typeof forwarded === 'function') forwarded(node)
    else if (forwarded) forwarded.current = node
  }
}
