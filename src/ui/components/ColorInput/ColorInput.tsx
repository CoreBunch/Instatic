/**
 * ColorInput — the swatch control every colour field in the editor renders.
 *
 * The swatch is a trigger: activating it opens the rich {@link ColorPicker} in
 * a portalled popover anchored to the swatch. There is no native
 * `<input type="color">` behind it any more — the native control can neither
 * express alpha nor reach the site's colour tokens.
 *
 * Read-only swatches (`disabled`) render the preview alone and never open.
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@ui/cn'
import { ColorPicker, safeCssColor, type ColorPickerToken } from '@ui/components/ColorPicker'
import styles from './ColorInput.module.css'

type ColorInputSize = 'xs' | 'sm' | 'md'

interface ColorInputProps {
  id?: string
  className?: string
  style?: CSSProperties
  fieldSize?: ColorInputSize
  disabled?: boolean
  /** Current colour value (`#rrggbb`, `rgb(...)`, `hsl(...)`, `var(--token)`). */
  value: string
  /** Optional preview override — use when `value` is a reference to resolve. */
  swatchValue?: string
  'aria-label'?: string
  /** Fires with the picked colour. Omit (or pass `disabled`) for preview-only swatches. */
  onValueChange?: (value: string) => void
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
  '--color-picker-anchor-x'?: string
  '--color-picker-anchor-y'?: string
}

/** Popover gap from the trigger, and the viewport margin it is clamped to. */
const POPOVER_GAP = 6
const VIEWPORT_MARGIN = 8
const POPOVER_WIDTH = 244
const POPOVER_HEIGHT = 430

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
  tokens,
  onSelectToken,
  onCreateToken,
  ref,
}: ColorInputProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const interactive = !disabled && onValueChange != null

  // Dismiss on outside pointerdown, Escape, or a viewport resize that would
  // strand the popover away from its trigger.
  useEffect(() => {
    if (anchor === null) return

    function close() {
      setAnchor(null)
    }
    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      close()
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('resize', close)
    }
  }, [anchor])

  function toggle() {
    if (!interactive) return
    if (anchor !== null) {
      setAnchor(null)
      return
    }
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setAnchor(clampToViewport(rect))
  }

  const displayValue = safeCssColor(swatchValue ?? value)
  const frameStyle: ColorInputStyle = { ...style, '--color-input-value': displayValue }

  return (
    <>
      <button
        id={id}
        type="button"
        ref={mergeRefs(triggerRef, ref)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={interactive ? anchor !== null : undefined}
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
      {anchor !== null && onValueChange && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={ariaLabel ? `${ariaLabel} picker` : 'Colour picker'}
            className={styles.popover}
            style={
              {
                '--color-picker-anchor-x': `${anchor.x}px`,
                '--color-picker-anchor-y': `${anchor.y}px`,
              } as ColorInputStyle
            }
          >
            <ColorPicker
              value={value}
              onChange={onValueChange}
              tokens={tokens}
              onSelectToken={(reference) => {
                onSelectToken?.(reference)
                setAnchor(null)
              }}
              onCreateToken={onCreateToken}
            />
          </div>,
          document.body,
        )}
    </>
  )
}

function clampToViewport(rect: DOMRect): { x: number; y: number } {
  const maxX = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN
  const maxY = window.innerHeight - POPOVER_HEIGHT - VIEWPORT_MARGIN
  const preferredY = rect.bottom + POPOVER_GAP
  return {
    x: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxX)),
    y: Math.max(VIEWPORT_MARGIN, Math.min(preferredY, maxY)),
  }
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
