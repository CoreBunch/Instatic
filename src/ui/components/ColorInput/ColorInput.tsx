/**
 * ColorInput — the swatch control every colour field in the editor renders.
 *
 * The swatch is a trigger: activating it opens the rich {@link ColorPicker}
 * inside a {@link FloatingPanel}, which owns the placement, the drag header
 * and the dismissal rules for every floating editor in the app. This file is
 * left with the swatch, the open flag, and the picker.
 *
 * A swatch that itself sits INSIDE a FloatingPanel (the border / effect
 * popouts) opts into drill-in via `drillInTitle`: the picker view then pushes
 * into that same panel — back arrow + contextual title — instead of stacking
 * a second one. Standalone swatches keep their own panel.
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
import { cn } from '@ui/cn'
import {
  FloatingPanel,
  FloatingPanelDrillView,
  useHasFloatingPanelHost,
} from '@ui/components/FloatingPanel'
import {
  ColorPicker,
  formatGradient,
  parseGradient,
  safeCssColor,
  type ColorPickerToken,
} from '@ui/components/ColorPicker'
import type { FieldSize } from '@ui/fieldSize'
import styles from './ColorInput.module.css'

interface ColorInputProps {
  id?: string
  className?: string
  style?: CSSProperties
  fieldSize?: FieldSize
  disabled?: boolean
  /** Current value (`#rrggbb`, `rgb(...)`, `hsl(...)`, `var(--token)`, or a gradient). */
  value: string
  /** Optional preview override — use when `value` is a reference to resolve. */
  swatchValue?: string
  'aria-label'?: string
  /** Fires with the picked colour. Omit (or pass `disabled`) for preview-only swatches. */
  onValueChange?: (value: string) => void
  /**
   * Fires when the picker panel opens or closes (including unmount-while-open).
   * The site editor uses it to show canvas affordances — e.g. the gradient
   * gizmo — only while the user is actually editing in the picker.
   */
  onOpenChange?: (open: boolean) => void
  /** Offer the picker's Solid / Linear / Radial fill tabs. */
  gradients?: boolean
  /** Site colour tokens shown in the picker's searchable list. */
  tokens?: readonly ColorPickerToken[]
  /** Fires when a token row is picked, with its `var(--name)` reference. */
  onSelectToken?: (reference: string) => void
  /** Enables the picker's "New Style" action. */
  onCreateToken?: (name: string, value: string) => void
  /**
   * Opt into drill-in: when set AND the swatch renders inside a
   * FloatingPanel, opening the picker pushes the picker view into THAT panel
   * under this contextual title (e.g. "Border color") instead of stacking a
   * second panel. Outside a panel the swatch keeps its own floating panel.
   */
  drillInTitle?: string
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<HTMLButtonElement>
}

type ColorInputStyle = CSSProperties & {
  '--color-input-value'?: string
  '--color-input-image'?: string
}

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
  onOpenChange,
  gradients = false,
  tokens,
  onSelectToken,
  onCreateToken,
  drillInTitle,
  ref,
}: ColorInputProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const interactive = !disabled && onValueChange != null
  const hasPanelHost = useHasFloatingPanelHost()

  // Mirror open/close (and unmount-while-open) to the caller through a ref so
  // an unstable callback prop can't retrigger the effect.
  const onOpenChangeRef = useRef(onOpenChange)
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  })
  useEffect(() => {
    onOpenChangeRef.current?.(open)
    return () => {
      if (open) onOpenChangeRef.current?.(false)
    }
  }, [open])

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
        onClick={() => {
          if (interactive) setOpen((wasOpen) => !wasOpen)
        }}
      >
        <span className={styles.preview} aria-hidden="true" />
      </button>
      {onValueChange &&
        (drillInTitle !== undefined && hasPanelHost ? (
          open && (
            <FloatingPanelDrillView title={drillInTitle} onBack={() => setOpen(false)}>
              <ColorPicker
                value={value}
                onChange={onValueChange}
                gradients={gradients}
                tokens={tokens}
                onSelectToken={onSelectToken}
                onCreateToken={onCreateToken}
              />
            </FloatingPanelDrillView>
          )
        ) : (
          <FloatingPanel
            open={open}
            onClose={() => setOpen(false)}
            anchorRef={triggerRef}
            title={ariaLabel ?? 'Fill'}
            ariaLabel={ariaLabel ? `${ariaLabel} picker` : 'Colour picker'}
            closeLabel="Close colour picker"
            /* The on-canvas gradient gizmo is this picker's companion surface —
               dragging it must not dismiss the picker it belongs to. */
            keepOpenSelector="[data-color-picker-keep-open]"
          >
            <ColorPicker
              value={value}
              onChange={onValueChange}
              gradients={gradients}
              tokens={tokens}
              onSelectToken={onSelectToken}
              onCreateToken={onCreateToken}
            />
          </FloatingPanel>
        ))}
    </>
  )
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
