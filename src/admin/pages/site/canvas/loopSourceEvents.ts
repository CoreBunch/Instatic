/**
 * The signal that the editor's list of plugin loop sources may be out of
 * date. Kept apart from the stores that send and hear it, so a sender (the
 * Publish button, in the editor's first chunk) does not pull them in.
 */

/** Fired on `window`; `usePluginLoopSources` refetches the list when it hears it. */
export const LOOP_SOURCES_STALE_EVENT = 'instatic:loop-sources-stale'

/** Ask the editor to refetch the list of plugin loop sources. */
export function requestLoopSourcesRefresh(): void {
  window.dispatchEvent(new Event(LOOP_SOURCES_STALE_EVENT))
}
