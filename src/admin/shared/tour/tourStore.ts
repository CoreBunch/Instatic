/**
 * tourStore — generic coach-mark tour engine.
 *
 * Holds the currently-running tour (if any) and the active step index.
 * `start()` is called by an editor-specific tour launcher with a
 * `TourStepDef[]` and an `onEnd` callback; `next` / `back` / `dismiss` /
 * `complete` drive it from there. Ending the tour (falling off the last
 * step via `next()`, or explicit `dismiss()` / `complete()`) clears the
 * running state and fires `onEnd` exactly once with the outcome.
 *
 * Kept editor-agnostic on purpose: no imports from `@site/*`, persistence,
 * or spotlight/overlay modules. The overlay component that renders steps
 * from this store lives alongside it in this folder; anything that knows
 * about a specific editor's panels/anchors is the caller's job via
 * `TourStepDef.prepare`.
 */
import { create } from 'zustand'
import type { TourOutcome, TourStepDef } from './types'

interface TourState {
  steps: TourStepDef[] | null
  stepIndex: number
  onEnd: ((outcome: TourOutcome) => void) | null
  /** Begins a tour. Throws if `steps` is empty. */
  start: (steps: TourStepDef[], onEnd: (outcome: TourOutcome) => void) => void
  /** Advances to the next step, or completes the tour on the last step. */
  next: () => void
  /** Moves back one step. No-op on the first step. */
  back: () => void
  /** Ends the tour early with a "dismissed" outcome. */
  dismiss: () => void
  /** Ends the tour with a "completed" outcome. */
  complete: () => void
}

export const useTourStore = create<TourState>()((set, get) => {
  function end(outcome: TourOutcome) {
    const { onEnd } = get()
    set({ steps: null, stepIndex: 0, onEnd: null })
    onEnd?.(outcome)
  }

  return {
    steps: null,
    stepIndex: 0,
    onEnd: null,
    start: (steps, onEnd) => {
      if (steps.length === 0) throw new Error('Tour needs at least one step')
      set({ steps, stepIndex: 0, onEnd })
    },
    next: () => {
      const { steps, stepIndex } = get()
      if (!steps) return
      if (stepIndex >= steps.length - 1) return end('completed')
      set({ stepIndex: stepIndex + 1 })
    },
    back: () => set((state) => ({ stepIndex: Math.max(0, state.stepIndex - 1) })),
    dismiss: () => end('dismissed'),
    complete: () => end('completed'),
  }
})
