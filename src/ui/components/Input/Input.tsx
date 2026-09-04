import {
  useEffect,
  useRef,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from '@ui/cn'
import type { FieldSize } from '@ui/fieldSize'
import { StepperChevronGlyph } from '@ui/icons/inspectorGlyphs'
import styles from './Input.module.css'

/** Pointer travel before a press on a number field becomes a scrub, not a click. */
const SCRUB_THRESHOLD = 4
/** Pixels of horizontal travel per step while scrubbing. */
const SCRUB_STEP_PX = 4
/** Shift turns each step into ten — the prototype's coarse drag. */
const SHIFT_MULTIPLIER = 10
/** Guard against a runaway loop if a scrub reports an absurd jump. */
const MAX_STEPS_PER_EVENT = 100
/**
 * Frames a scrub waits for the field to show the previous step before it
 * applies the next batch. A row's step math is relative to its rendered
 * value, so stepping again before React painted the last commit would step
 * from a stale base (740 → 732, then 740 − 3 = 737: the value bounces).
 * Capped, because a step that legitimately changes nothing (already at the
 * floor) must not stall the drag.
 */
const SCRUB_ACK_FRAMES = 3

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
   * Use for affordances that belong *inside* the field's border â€” e.g. a
   * submit-affordance enter-key icon for search/picker inputs. The slot is
   * mutually compatible with `prefix` and `unit`. Mutually exclusive with
   * `numberSpinner` (the slot is suppressed for number inputs).
   */
  trailingSlot?: ReactNode
  /**
   * When true (default for `type="number"`), the native browser spinner is
   * hidden and a pair of compact `â–˛ / â–Ľ` buttons is rendered inside the
   * trailing edge of the input. The buttons inherit the input's `step`,
   * `min`, `max` and dispatch a synthetic `change` event so controlled
   * components stay in sync.
   *
   * Pass `false` to opt out (e.g. for read-only numeric displays).
   */
  numberSpinner?: boolean
  /**
   * Renders the same hover-revealed stepper column on a NON-number input and
   * delegates each step to this handler. Use for dimension fields whose value
   * is free-form text (`100%`, `auto`, `var(--space-l)`) but still has a
   * numeric part worth stepping.
   *
   * `delta` is any integer: a chevron sends ±1, a Shift-drag sends ±10, and a
   * fast scrub sends however many steps it crossed between two pointer events.
   */
  onStep?: (delta: number) => void
  /**
   * The scrub as a SESSION, for fields that can preview: called once per
   * frame with the TOTAL steps since the grab (`'move'` — the caller previews
   * `start + total`, so no step ever reads a stale base) and once on release
   * (`'end'` — the caller commits). Chevrons and arrow keys still go through
   * `onStep`. Without this, a scrub batches into `onStep` instead.
   */
  onScrub?: (totalSteps: number, phase: 'move' | 'end') => void
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
  onStep,
  onScrub,
  type,
  autoComplete = 'off',
  ref,
  ...props
}: InputProps) {
  const isNumber = type === 'number'
  // Number inputs get the spinner by default; any input gets one when the
  // caller supplies `onStep` (free-form dimension fields).
  const showSpinner = (isNumber && (numberSpinner ?? true)) || onStep != null
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

  function nudge(delta: number) {
    const el = localRef.current
    if (!el || el.disabled || el.readOnly) return
    for (let i = 0; i < Math.min(Math.abs(delta), MAX_STEPS_PER_EVENT); i += 1) {
      if (delta > 0) el.stepUp()
      else el.stepDown()
    }
    // stepUp/stepDown do NOT fire input/change events automatically — emit one
    // so controlled components see the new value.
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const step = (delta: number) => (onStep ? onStep(delta) : nudge(delta))
  // The scrub's window listeners outlive the render that started them, but
  // a caller's step math reads the value of the render it belongs to — so
  // every batch must reach the LATEST handler, never the one captured at
  // pointerdown (that one would step from the pre-drag value forever).
  const stepRef = useRef(step)
  const scrubRef = useRef(onScrub)
  useEffect(() => {
    stepRef.current = step
    scrubRef.current = onScrub
  })

  /**
   * A field with a stepper is a numeric control, so it answers the keyboard
   * the way a native number input does: ArrowUp / ArrowDown step the value,
   * Shift makes it coarse — the same contract as the chevrons and the scrub.
   * Native number inputs keep the browser's own arrow behaviour instead.
   */
  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    props.onKeyDown?.(event)
    if (event.defaultPrevented || !onStep || props.disabled || props.readOnly) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    step((event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? SHIFT_MULTIPLIER : 1))
  }

  /**
   * Drag left/right on the field to scrub its value — the prototype's
   * `.numberfield` behaviour, and the reason a field with a stepper wears the
   * `ew-resize` cursor.
   *
   * A press is NOT a drag until the pointer has travelled `SCRUB_THRESHOLD`,
   * so clicking to place the caret and selecting text both still work; past
   * that threshold the field gives up focus and the browser's text selection
   * is cleared, because you are no longer editing text, you are turning a
   * dial. Shift multiplies each step by ten.
   */
  function beginScrub(event: ReactPointerEvent<HTMLSpanElement>) {
    if (event.button !== 0 || props.disabled || props.readOnly) return
    // Chevrons and any trailing affordance keep their own click.
    if (event.target instanceof Element && event.target.closest('button')) return
    const wrapper = event.currentTarget
    const pointerId = event.pointerId
    const startX = event.clientX
    let anchor = startX
    let scrubbing = false
    // Steps accumulated since the last frame; applied once per frame so a
    // high-rate mouse (1000 Hz) cannot turn one drag into hundreds of store
    // commits — the value moves as far, in far fewer writes.
    let pending = 0
    let frame = 0
    // Session mode (onScrub): the caller previews `start + total` per frame
    // and commits on release — every frame is relative to the grab, so
    // there is no stale base and nothing to wait for.
    const session = scrubRef.current
    let total = 0
    // The field text after the last applied batch — the ack that React has
    // painted it — and how many frames the next batch has waited for it.
    // Only the onStep fallback needs it: its steps are relative to the
    // rendered value.
    let lastSeen: string | null = null
    let waited = 0

    const applyPending = () => {
      const delta = pending
      pending = 0
      waited = 0
      if (session) {
        total += delta
        session(total, 'move')
        return
      }
      stepRef.current(delta)
      lastSeen = localRef.current?.value ?? null
    }

    const flush = () => {
      frame = 0
      if (pending === 0) return
      if (
        !session &&
        lastSeen !== null &&
        localRef.current?.value === lastSeen &&
        waited < SCRUB_ACK_FRAMES
      ) {
        waited += 1
        frame = requestAnimationFrame(flush)
        return
      }
      applyPending()
    }

    const handleMove = (move: PointerEvent) => {
      if (!scrubbing) {
        if (Math.abs(move.clientX - startX) < SCRUB_THRESHOLD) return
        scrubbing = true
        wrapper.dataset.scrubbing = 'true'
        localRef.current?.blur()
        document.getSelection()?.removeAllRanges()
        // From here on the pointer belongs to the dial: capture keeps every
        // move coming to this element even over the canvas iframe (which
        // would otherwise swallow them and hand back one giant jump on
        // re-entry), and stops the browser's text-selection drag.
        try {
          wrapper.setPointerCapture(pointerId)
        } catch {
          // Some test envs reject setPointerCapture; window listeners still run.
        }
      }
      move.preventDefault()
      const steps = Math.trunc((move.clientX - anchor) / SCRUB_STEP_PX)
      if (steps === 0) return
      anchor += steps * SCRUB_STEP_PX
      pending += steps * (move.shiftKey ? SHIFT_MULTIPLIER : 1)
      if (frame === 0) frame = requestAnimationFrame(flush)
    }
    const handleEnd = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      // Release applies what is left right away — no ack to wait for — and
      // closes a session so the caller commits once.
      if (pending !== 0) applyPending()
      if (session && scrubbing) session(total, 'end')
      delete wrapper.dataset.scrubbing
      try {
        if (wrapper.hasPointerCapture(pointerId)) wrapper.releasePointerCapture(pointerId)
      } catch {
        // Nothing to release when capture was refused above.
      }
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
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
        // Native arrows are ALWAYS suppressed on number inputs â€” the custom
        // spinner is the only set of controls ever shown; numberSpinner={false}
        // means no arrows at all, not the browser's.
        isNumber && styles.numberNoSpinner,
        hasAffix && styles.inputWithAffix,
        !hasAffix && className,
      )}
      {...props}
      onKeyDown={onStep ? handleKeyDown : props.onKeyDown}
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
      onPointerDown={showSpinner ? beginScrub : undefined}
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
            onClick={() => step(1)}
          >
            <StepperChevronGlyph />
          </button>
          <button
            type="button"
            className={cn(styles.spinnerButton, styles.spinnerButtonDown)}
            tabIndex={-1}
            aria-label="Decrease"
            disabled={props.disabled}
            onClick={() => step(-1)}
          >
            <StepperChevronGlyph />
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
