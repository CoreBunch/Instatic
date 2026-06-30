/**
 * FrameworkManagerApplier — the persistence seam behind FrameworkManagerDialog.
 *
 * The dialog is presentation-only; it lets the user pick one declarative target
 * state and calls `apply(target)`. The applier performs the actual mutation.
 *   • site editor → store action `setFrameworkPreset` (reconcile + undo).
 *     `capabilities.canRemove === true`.
 *   • onboarding  → cmsAdapter import only; `apply('none')` is never offered
 *     because `capabilities.canRemove === false` hides the "None" state.
 */
import type { FrameworkPreset } from '@core/framework'

export interface FrameworkManagerApplier {
  /** When false the "None" (remove) state is hidden and apply never gets 'none'. */
  capabilities: { canRemove: boolean }
  /** Reconcile the framework to the chosen target state. */
  apply: (target: FrameworkPreset) => Promise<void>
}
