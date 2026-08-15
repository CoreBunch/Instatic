/**
 * TourOverlay — coach-mark renderer for `useTourStore`.
 *
 * Renders nothing while idle. When a tour is running, portals a dim
 * backdrop — an SVG spotlight cutout around the active step's anchor, or a
 * plain scrim for centered steps — plus a positioned bubble (progress,
 * title, body, Skip/Back/Next) to `document.body`.
 *
 * Three-component shape:
 *   - `TourOverlay` bails out before any hooks run when there's nothing to
 *     show (same trick as `Tooltip`'s `disabled` path), so the idle render
 *     stays hook-free without violating the rules of hooks.
 *   - `TourOverlayInner` owns the store subscriptions that live for the
 *     whole tour (current step index, the Escape-to-dismiss listener).
 *   - `TourStep`, remounted via `key={stepIndex}` on every step change, owns
 *     the per-step lifecycle: `step.prepare?.()`, then locating the anchor
 *     (or going straight to centered). Remounting instead of resetting
 *     state in an effect means each step starts from real `useState`
 *     initial values — no imperative "clear the previous step's state"
 *     effect needed.
 *
 * A step that never finds its anchor is soft-skipped: `waitForAnchor` polls
 * `[data-testid="<anchor>"]` for up to two seconds, then — on timeout —
 * logs and advances past it rather than leaving the tour stuck on a target
 * that never appeared.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { computeFloatingPosition, type ResolvedFloatingSide } from '@ui/lib/floatingPosition'
import { useTourStore } from './tourStore'
import type { TourStepDef } from './types'
import styles from './TourOverlay.module.css'

/** How long a step waits for its anchor before soft-skipping. */
const ANCHOR_WAIT_TIMEOUT_MS = 2000
/** Outward inflation of the spotlight cutout past the anchor's own rect. */
const SPOTLIGHT_INFLATE = 6
const SPOTLIGHT_RADIUS = 8
const BUBBLE_OFFSET = 12
const BUBBLE_EDGE_PADDING = 16
const BUBBLE_AUTO_PRIORITY = ['bottom', 'top', 'right', 'left'] as const

/**
 * Polls `document.querySelector('[data-testid="<testId>"]')` once per
 * animation frame until the element appears or `timeoutMs` elapses.
 */
function waitForAnchor(testId: string, timeoutMs: number): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs
    const poll = () => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      if (el) {
        resolve(el)
        return
      }
      if (performance.now() >= deadline) {
        resolve(null)
        return
      }
      requestAnimationFrame(poll)
    }
    poll()
  })
}

interface BubblePosition {
  x: number
  y: number
  side: ResolvedFloatingSide
}

export function TourOverlay() {
  const steps = useTourStore((s) => s.steps)
  if (steps === null) return null
  return <TourOverlayInner steps={steps} />
}

function TourOverlayInner({ steps }: { steps: TourStepDef[] }) {
  const stepIndex = useTourStore((s) => s.stepIndex)
  const next = useTourStore((s) => s.next)
  const back = useTourStore((s) => s.back)
  const dismiss = useTourStore((s) => s.dismiss)

  // Escape dismisses the tour from anywhere while it's active — the whole
  // point of a passive coach mark is that the user can bail without
  // hunting for a close button. Lives here (not in `TourStep`, which
  // remounts every step) so it stays subscribed across step changes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      dismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dismiss])

  return (
    <TourStep
      key={stepIndex}
      step={steps[stepIndex]}
      stepNumber={stepIndex + 1}
      totalSteps={steps.length}
      onNext={next}
      onBack={back}
      onDismiss={dismiss}
    />
  )
}

interface TourStepProps {
  step: TourStepDef
  stepNumber: number
  totalSteps: number
  onNext: () => void
  onBack: () => void
  onDismiss: () => void
}

function TourStep({ step, stepNumber, totalSteps, onNext, onBack, onDismiss }: TourStepProps) {
  const isFirstStep = stepNumber === 1
  const isLastStep = stepNumber === totalSteps
  const titleId = useId()
  const maskId = `${titleId}-mask`
  const bubbleRef = useRef<HTMLDivElement>(null)

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const [ready, setReady] = useState(false)
  const [position, setPosition] = useState<BubblePosition | null>(null)

  // Locate this step's target: run `prepare()`, then either go straight to
  // "ready" (centered step) or wait for the anchor to appear. `cancelled`
  // guards against this component unmounting (the store moved to a
  // different step, or ended the tour) while the wait is still pending.
  useEffect(() => {
    let cancelled = false

    const run = async () => {
      try {
        await step.prepare?.()
      } catch (err) {
        console.warn('[tour] prepare failed, skipping step:', step.id, err)
        if (cancelled) return
        onNext()
        return
      }
      if (cancelled) return

      if (step.anchor === null) {
        setReady(true)
        return
      }

      const el = await waitForAnchor(step.anchor, ANCHOR_WAIT_TIMEOUT_MS)
      if (cancelled) return

      if (!el) {
        console.warn('[tour] anchor missing, skipping step:', step.id)
        onNext()
        return
      }

      setAnchorEl(el)
      setAnchorRect(el.getBoundingClientRect())
      setReady(true)
    }

    run()
    return () => {
      cancelled = true
    }
  }, [step, onNext])

  // Re-measure the anchor's rect on resize, scroll, or its own layout
  // changes, so the spotlight cutout and bubble position stay glued to it.
  useEffect(() => {
    if (!anchorEl) return
    const measure = () => setAnchorRect(anchorEl.getBoundingClientRect())
    const observers: ResizeObserver[] = []
    if (typeof ResizeObserver !== 'undefined') {
      const anchorObserver = new ResizeObserver(measure)
      anchorObserver.observe(anchorEl)
      observers.push(anchorObserver)
      if (bubbleRef.current) {
        const bubbleObserver = new ResizeObserver(measure)
        bubbleObserver.observe(bubbleRef.current)
        observers.push(bubbleObserver)
      }
    }
    window.addEventListener('resize', measure)
    // Capture phase: any scrollable ancestor (not just window) can move the
    // anchor, and scroll events don't bubble.
    document.addEventListener('scroll', measure, true)
    return () => {
      observers.forEach((observer) => observer.disconnect())
      window.removeEventListener('resize', measure)
      document.removeEventListener('scroll', measure, true)
    }
  }, [anchorEl])

  // Compute the bubble's floating position once it's measurable. Centered
  // steps (no anchor, `anchorRect` stays null) are placed by CSS alone.
  useLayoutEffect(() => {
    if (!ready || !anchorRect) return
    const bubbleEl = bubbleRef.current
    if (!bubbleEl) return
    const { width, height } = bubbleEl.getBoundingClientRect()
    const computed = computeFloatingPosition(anchorRect, {
      floatingWidth: width,
      floatingHeight: height,
      side: step.side ?? 'auto',
      align: step.align ?? 'center',
      offset: BUBBLE_OFFSET,
      edgePadding: BUBBLE_EDGE_PADDING,
      autoPriority: BUBBLE_AUTO_PRIORITY,
    })
    setPosition({ x: computed.x, y: computed.y, side: computed.side })
  }, [ready, anchorRect, step.side, step.align])

  // Focus the bubble once it mounts so screen readers announce it and
  // keyboard focus doesn't stay pinned to whatever was focused before.
  useEffect(() => {
    if (!ready) return
    bubbleRef.current?.focus()
  }, [ready])

  if (!ready) return null

  const anchored = anchorRect !== null

  const bubbleStyle = {
    '--tour-x': position ? `${position.x}px` : '0px',
    '--tour-y': position ? `${position.y}px` : '0px',
  } as CSSProperties

  return createPortal(
    <>
      <div className={styles.backdrop} data-anchored={anchored || undefined}>
        {anchored && anchorRect && (
          <svg className={styles.spotlightSvg} aria-hidden="true">
            <mask id={maskId}>
              <rect width="100%" height="100%" fill="white" />
              <rect
                className={styles.spotlightHole}
                x={anchorRect.left - SPOTLIGHT_INFLATE}
                y={anchorRect.top - SPOTLIGHT_INFLATE}
                width={anchorRect.width + SPOTLIGHT_INFLATE * 2}
                height={anchorRect.height + SPOTLIGHT_INFLATE * 2}
                rx={SPOTLIGHT_RADIUS}
                fill="black"
              />
            </mask>
            <rect className={styles.spotlightDim} width="100%" height="100%" mask={`url(#${maskId})`} />
          </svg>
        )}
      </div>
      <div
        ref={bubbleRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={styles.bubble}
        data-position={anchored ? 'anchored' : 'centered'}
        data-side={position?.side}
        style={bubbleStyle}
      >
        <p className={styles.progress}>
          Step {stepNumber} of {totalSteps}
        </p>
        <h2 id={titleId} className={styles.title}>
          {step.title}
        </h2>
        <p className={styles.body}>{step.body}</p>
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Skip tour
          </Button>
          <div className={styles.navActions}>
            {!isFirstStep && (
              <Button variant="secondary" size="sm" onClick={onBack}>
                Back
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={onNext}>
              {isLastStep ? 'Finish' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
