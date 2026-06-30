import {
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from '@ui/cn'
import { ChevronDown2Icon } from 'pixel-art-icons/icons/chevron-down-2'
import styles from './Input.module.css'

type FieldSize = 'xs' | 'sm' | 'md'
type TextEmphasis = 'default' | 'strong'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
  fieldSize?: FieldSize
  monospace?: boolean
  emphasis?: TextEmphasis
  /**
   * Optional prefix displayed inside the input on the leading edge
   * (e.g. "--", "$", "@"). Renders to the left of the value, inside
   * the same border so it reads as part of the field.
   */
  prefix?: string
  /**
   * Optional unit displayed inside the input on the trailing edge
   * (e.g. "px", "rem", "%"). Renders to the right of the value, inside
   * the same border so it reads as part of the field.
   */
  unit?: string
  /**
   * Optional arbitrary trailing-slot content rendered inside the field on
   * the trailing edge (after `unit`, before the number-spinner column).
   * Use for affordances that belong *inside* the field's border — e.g. a
   * submit-affordance enter-key icon for search/picker inputs. The slot is
   * mutually compatible with `prefix` and `unit`. Mutually exclusive with
   * `numberSpinner` (the slot is suppressed for number inputs).
   */
  trailingSlot?: ReactNode
  /**
   * When true (default for `type="number"`), the native browser spinner is
   * hidden and a pair of compact `▲ / ▼` buttons is rendered inside the
   * trailing edge of the input. The buttons inherit the input's `step`,
   * `min`, `max` and dispatch a synthetic `change` event so controlled
   * components stay in sync.
   *
   * Pass `false` to opt out (e.g. for read-only numeric displays).
   */
  numberSpinner?: boolean
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<HTMLInputElement>
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
  fieldSize?: FieldSize
  monospace?: boolean
  emphasis?: TextEmphasis
  resize?: 'none' | 'vertical' | 'both'
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<HTMLTextAreaElement>
}

export function Input({
  className,
  invalid = false,
  fieldSize = 'md',
  monospace = false,
  emphasis = 'default',
  prefix,
  unit,
  trailingSlot,
  numberSpinner,
  type,
  autoComplete = 'off',
  ref,
  ...props
}: InputProps) {
  const isNumber = type === 'number'
  // Only number inputs get the spinner. Default on for number, off otherwise.
  const showSpinner = isNumber && (numberSpinner ?? true)
  // The trailing slot is suppressed for number inputs so it cannot collide
  // with the spinner column (number inputs own that real estate).
  const showTrailingSlot = !isNumber && trailingSlot != null
  const hasAffix = Boolean(prefix) || Boolean(unit) || showSpinner || showTrailingSlot

  const localRef = useRef<HTMLInputElement | null>(null)
  const setRef = (node: HTMLInputElement | null) => {
    localRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }

  function nudge(delta: 1 | -1) {
    const el = localRef.current
    if (!el || el.disabled || el.readOnly) return
    if (delta === 1) el.stepUp()
    else el.stepDown()
    // stepUp/stepDown do NOT fire input/change events automatically — emit one
    // so controlled components see the new value.
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const inputElement = (
    <input
      ref={setRef}
      type={type}
      autoComplete={autoComplete}
      aria-invalid={invalid || props['aria-invalid'] ? true : undefined}
      data-emphasis={emphasis !== 'default' ? emphasis : undefined}
      data-prefixed={prefix ? 'true' : undefined}
      className={cn(
        styles.input,
        styles[`size-${fieldSize}`],
        monospace && styles.monospace,
        invalid && styles.invalid,
        showSpinner && styles.numberNoSpinner,
        hasAffix && styles.inputWithAffix,
        !hasAffix && className,
      )}
      {...props}
    />
  )

  if (!hasAffix) return inputElement

  return (
    <span
      className={cn(
        styles.inputWrapper,
        styles[`size-${fieldSize}`],
        invalid && styles.invalid,
        className,
      )}
      data-disabled={props.disabled ? 'true' : undefined}
    >
      {prefix && <span className={styles.prefix} aria-hidden="true">{prefix}</span>}
      {inputElement}
      {unit && <span className={styles.unit} aria-hidden="true">{unit}</span>}
      {showTrailingSlot && (
        <span className={styles.trailingSlot}>{trailingSlot}</span>
      )}
      {showSpinner && (
        <span className={styles.spinner} aria-hidden="true">
          <button
            type="button"
            className={styles.spinnerButton}
            tabIndex={-1}
            aria-label="Increase"
            disabled={props.disabled}
            onClick={() => nudge(1)}
          >
            <ChevronDown2Icon size={9} className={styles.spinnerIconUp} />
          </button>
          <button
            type="button"
            className={styles.spinnerButton}
            tabIndex={-1}
            aria-label="Decrease"
            disabled={props.disabled}
            onClick={() => nudge(-1)}
          >
            <ChevronDown2Icon size={9} />
          </button>
        </span>
      )}
    </span>
  )
}

export function Textarea({
  className,
  invalid = false,
  fieldSize = 'md',
  monospace = false,
  emphasis = 'default',
  resize = 'vertical',
  autoComplete = 'off',
  ref,
  ...props
}: TextareaProps) {
  return (
    <textarea
      ref={ref}
      autoComplete={autoComplete}
      aria-invalid={invalid || props['aria-invalid'] ? true : undefined}
      data-emphasis={emphasis !== 'default' ? emphasis : undefined}
      data-resize={resize}
      className={cn(
        styles.input,
        styles.textarea,
        styles[`size-${fieldSize}`],
        monospace && styles.monospace,
        invalid && styles.invalid,
        className,
      )}
      {...props}
    />
  )
}
