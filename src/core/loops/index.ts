/**
 * `@core/loops` barrel — the public entry point for the loop engine.
 *
 * External callers (admin canvas, panels) import the shared loop-item
 * mapping helpers from here so they CONSUME the engine's projection instead
 * of re-deriving it. The canonical `site.pages` loop-item shape and its
 * template include/exclude filter live in `./sources/sitePages` and are
 * re-exported here; the editor canvas preview (`useLoopPreviewItems`) uses
 * them to guarantee canvas previews and published output never diverge.
 */

export type { LoopItem } from './types'
export { pageToLoopItem, filterPagesForLoop } from './sources/sitePages'
