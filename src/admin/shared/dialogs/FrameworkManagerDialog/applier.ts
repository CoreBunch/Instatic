/**
 * FrameworkManagerApplier — the persistence seam behind FrameworkManagerDialog.
 *
 * The dialog is presentation-only; the applier performs the actual mutation.
 *   • site editor → store actions (import + remove + prune, with reconcile + undo)
 *   • onboarding  → cmsAdapter import only (`capabilities.canRemove === false`)
 */
export type FrameworkImportMode = 'full' | 'variables'

export interface FrameworkManagerApplier {
  /** Removal needs reconcile + undo — only the site-editor applier sets this true. */
  capabilities: { canRemove: boolean }
  import: (mode: FrameworkImportMode) => Promise<void>
  removeAll?: () => Promise<void>
  pruneUnused?: () => Promise<void>
}
