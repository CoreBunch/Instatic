/**
 * tour/types — shape of a generic coach-mark tour.
 *
 * A tour is an ordered list of `TourStepDef`s driven by `tourStore`. This
 * module knows nothing about any specific editor, panel, or feature — it is
 * the vocabulary a caller uses to describe "show this bubble, pointing at
 * this element, with this copy." Editor-specific tours (e.g. the Site editor
 * onboarding tour) live elsewhere and build `TourStepDef[]` arrays against
 * this type; this module stays reusable across every future tour.
 */
import type { FloatingAlign, FloatingSide } from '@ui/lib/floatingPosition'

/** How a tour ended — passed to the `onEnd` callback given to `start()`. */
export type TourOutcome = 'completed' | 'dismissed'

/** One step in a tour. */
export interface TourStepDef {
  /** Stable identifier for the step (analytics, debugging). */
  id: string
  /** data-testid of the anchor element; null = centered step (welcome/finish). */
  anchor: string | null
  title: string
  body: string
  side?: FloatingSide
  align?: FloatingAlign
  /** Runs before the step shows — open the panel that contains the anchor, etc. */
  prepare?: () => void | Promise<void>
}
