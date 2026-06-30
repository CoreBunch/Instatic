/**
 * Admin-wide DOM custom events.
 *
 * Kept in a dedicated module so importers don't transitively pull in the
 * heavy modules that *dispatch* / *listen* to these events. In particular,
 * the editor's `usePersistence` hook (~6 KB chunk, drags the full editor
 * store) used to own `CMS_SITE_RELOAD_EVENT` — any plugin-side code that
 * just wanted to dispatch the event would import usePersistence and end
 * up bundling the editor store into the non-editor admin graph.
 *
 * Adding new admin-wide event constants? Put them here, then have both
 * dispatchers and listeners import from this module.
 */

/**
 * Fired on `window` after the editor reloads the site document (manual
 * save → reload, plugin install → reload). Subscribers re-fetch any
 * site-derived data they cache (admin shell site name + favicon,
 * Plugins page list, etc.).
 */
export const CMS_SITE_RELOAD_EVENT = 'cms-site-reload'

let cmsSiteReloadPending = false

/**
 * Request an editor-site reload and retain that request if the Site editor is
 * not mounted yet. Callers that mutate site-backed storage outside the editor
 * should use this helper instead of dispatching `CMS_SITE_RELOAD_EVENT`
 * directly.
 */
export function requestCmsSiteReload(): void {
  cmsSiteReloadPending = true
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CMS_SITE_RELOAD_EVENT))
  }
}

export function hasPendingCmsSiteReload(): boolean {
  return cmsSiteReloadPending
}

export function consumePendingCmsSiteReload(): boolean {
  if (!cmsSiteReloadPending) return false
  cmsSiteReloadPending = false
  return true
}

/**
 * Fired after a CMS-exported SiteBundle has been imported successfully through
 * the global Site Import modal. Data/content views that cache table or row
 * lists should refresh when they are mounted.
 */
export const CMS_SITE_BUNDLE_IMPORTED_EVENT = 'cms-site-bundle-imported'

/**
 * Fired on `window` to ask the mounted Site editor to persist the current draft
 * immediately, bypassing the autosave debounce. Used by deliberate, discrete
 * save actions (e.g. "Save as layout") so the change is written to storage at
 * the moment the user takes the action — instead of waiting for the autosave
 * timer, which is dropped entirely if the user navigates away from the editor
 * before it fires. `usePersistence` listens and runs its normal save pipeline.
 */
export const EDITOR_SAVE_REQUEST_EVENT = 'editor-save-request'

/**
 * Request an immediate editor-draft save. No-op when no editor is mounted (the
 * change still rides the next save the way any other unsaved edit would).
 */
export function requestEditorSave(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(EDITOR_SAVE_REQUEST_EVENT))
  }
}
