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
 *     whole tour (current step index, the Escape-to-dismiss listener) AND
 *     the persistent backdrop + bubble DOM. The bubble is a single element
 *     for the whole tour — it never remounts between steps — so its
 *     position can transition smoothly via CSS instead of popping in fresh
 *     at (0, 0) every step. `displayed` holds the last step that finished
 *     resolving (content + anchor element); while the *next* step is still
 *     resolving, the bubble keeps showing `displayed`'s content in place —
 *     no blank gap, no flash.
 *   - `TourStepResolver`, remounted via `key={stepIndex}` on every step
 *     change, is a non-visual controller that runs the per-step lifecycle:
 *     `step.prepare?.()`, then locates the anchor (or goes straight to
 *     centered), and reports the result upward through the `onResolved`
 *     prop (`setDisplayed` itself — a `useState` setter, always stable).
 *     Remounting instead of resetting state in an effect means each step's
 *     resolver starts from real `useState`/closure initial values — no
 *     imperative "clear the previous step's state" effect needed, and
 *     since `onResolved`/`onNext` are only ever called *after* an `await`,
 *     none of this trips `react-hooks/set-state-in-effect` (that rule
 *     targets synchronous setState at the top of an effect — which is
 *     exactly what remounting-by-key was already avoiding for local state,
 *     and an async call after a real await is a genuine effect, not a
 *     "should've been computed during render" case).
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
  /** `null` for centered steps — no anchor side to report. */
  side: ResolvedFloatingSide | null
}

/** Centers the bubble in the viewport — the pixel-position equivalent of a
 * centered step, computed the same `--tour-x`/`--tour-y` way anchored steps
 * are, so both kinds of step animate through the same transform. */
function computeCenteredPosition(width: number, height: number): BubblePosition {
  return {
    x: Math.max(0, (window.innerWidth - width) / 2),
    y: Math.max(0, (window.innerHeight - height) / 2),
    side: null,
  }
}

/** The last step to finish resolving — what the persistent bubble shows. */
interface DisplayedStep {
  step: TourStepDef
  stepNumber: number
  /** `null` for a centered step. */
  anchorEl: HTMLElement | null
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

  const titleId = useId()
  const maskId = `${titleId}-mask`
  const bubbleRef = useRef<HTMLDivElement>(null)

  const [displayed, setDisplayed] = useState<DisplayedStep | null>(null)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const [position, setPosition] = useState<BubblePosition | null>(null)

  // Escape dismisses the tour from anywhere while it's active — the whole
  // point of a passive coach mark is that the user can bail without
  // hunting for a close button. Lives here (not in the per-step resolver,
  // which remounts every step) so it stays subscribed across step changes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      dismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dismiss])

  // Track the displayed step's anchor (or centered layout) and keep the
  // bubble glued to it: re-measures on the anchor's own resize, the
  // bubble's own resize (content reflow between steps), window resize, and
  // scroll. `useLayoutEffect`, not `useEffect`, so a freshly-resolved
  // step's position is committed to the DOM before the browser paints —
  // that's what keeps a brand-new bubble from ever flashing at (0, 0).
  useLayoutEffect(() => {
    const bubbleEl = bubbleRef.current
    if (!displayed || !bubbleEl) {
      setAnchorRect(null)
      return
    }

    const recompute = () => {
      const rect = displayed.anchorEl ? displayed.anchorEl.getBoundingClientRect() : null
      setAnchorRect(rect)
      const { width, height } = bubbleEl.getBoundingClientRect()
      if (rect) {
        const computed = computeFloatingPosition(rect, {
          floatingWidth: width,
          floatingHeight: height,
          side: displayed.step.side ?? 'auto',
          align: displayed.step.align ?? 'center',
          offset: BUBBLE_OFFSET,
          edgePadding: BUBBLE_EDGE_PADDING,
          autoPriority: BUBBLE_AUTO_PRIORITY,
        })
        setPosition({ x: computed.x, y: computed.y, side: computed.side })
      } else {
        setPosition(computeCenteredPosition(width, height))
      }
    }

    recompute()

    const observers: ResizeObserver[] = []
    if (typeof ResizeObserver !== 'undefined') {
      // The bubble's own size (content reflow between steps) affects where
      // it should sit even when the anchor hasn't moved.
      const bubbleObserver = new ResizeObserver(recompute)
      bubbleObserver.observe(bubbleEl)
      observers.push(bubbleObserver)
      if (displayed.anchorEl) {
        const anchorObserver = new ResizeObserver(recompute)
        anchorObserver.observe(displayed.anchorEl)
        observers.push(anchorObserver)
      }
    }
    window.addEventListener('resize', recompute)
    // Capture phase: any scrollable ancestor (not just window) can move the
    // anchor, and scroll events don't bubble.
    document.addEventListener('scroll', recompute, true)
    return () => {
      observers.forEach((observer) => observer.disconnect())
      window.removeEventListener('resize', recompute)
      document.removeEventListener('scroll', recompute, true)
    }
  }, [displayed])

  // Focus the bubble when a NEW step's content lands — not on every
  // reposition (the effect above re-runs far more often than `displayed`
  // changes, e.g. on every scroll).
  useEffect(() => {
    if (!displayed) return
    bubbleRef.current?.focus()
  }, [displayed])

  const anchored = displayed !== null && anchorRect !== null
  const isFirstStep = displayed !== null && displayed.stepNumber === 1
  const isLastStep = displayed !== null && displayed.stepNumber === steps.length

  const bubbleStyle = {
    '--tour-x': position ? `${position.x}px` : '0px',
    '--tour-y': position ? `${position.y}px` : '0px',
  } as CSSProperties

  return (
    <>
      <TourStepResolver
        key={stepIndex}
        step={steps[stepIndex]}
        stepNumber={stepIndex + 1}
        onResolved={setDisplayed}
        onNext={next}
      />
      {displayed &&
        createPortal(
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
              data-side={position?.side ?? undefined}
              style={bubbleStyle}
            >
              <p className={styles.progress}>
                Step {displayed.stepNumber} of {steps.length}
              </p>
              <h2 id={titleId} className={styles.title}>
                {displayed.step.title}
              </h2>
              <p className={styles.body}>{displayed.step.body}</p>
              <div className={styles.actions}>
                <Button variant="ghost" size="sm" onClick={dismiss}>
                  Skip tour
                </Button>
                <div className={styles.navActions}>
                  {!isFirstStep && (
                    <Button variant="secondary" size="sm" onClick={back}>
                      Back
                    </Button>
                  )}
                  <Button variant="primary" size="sm" onClick={next}>
                    {isLastStep ? 'Finish' : 'Next'}
                  </Button>
                </div>
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  )
}

interface TourStepResolverProps {
  step: TourStepDef
  stepNumber: number
  onResolved: (resolved: DisplayedStep) => void
  onNext: () => void
}

/**
 * Non-visual per-step controller — renders nothing. Remounted via
 * `key={stepIndex}` in `TourOverlayInner`, so every step starts this
 * lifecycle fresh: run `step.prepare?.()`, then either go straight to
 * "resolved" (centered step) or wait for the anchor to appear. `cancelled`
 * guards against this component unmounting (the store moved to a
 * different step, or ended the tour) while the wait is still pending.
 */
function TourStepResolver({ step, stepNumber, onResolved, onNext }: TourStepResolverProps) {
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
        onResolved({ step, stepNumber, anchorEl: null })
        return
      }

      const el = await waitForAnchor(step.anchor, ANCHOR_WAIT_TIMEOUT_MS)
      if (cancelled) return

      if (!el) {
        console.warn('[tour] anchor missing, skipping step:', step.id)
        onNext()
        return
      }

      onResolved({ step, stepNumber, anchorEl: el })
    }

    run()
    return () => {
      cancelled = true
    }
  }, [step, stepNumber, onResolved, onNext])

  return null
}
