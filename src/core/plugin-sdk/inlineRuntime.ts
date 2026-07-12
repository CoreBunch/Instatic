/**
 * The SDK's INLINABLE runtime surface — what `@instatic/plugin-sdk` resolves
 * to when a bundle must be self-contained (site plugin builds map the bare
 * specifier here via the containment policy; sandbox and frontend bundles
 * have no import map or module resolver).
 *
 * Deliberately NOT the full SDK barrel: the barrel re-exports TypeBox-backed
 * schema modules (`contentSchemas`, `storageSchemas`, `guards`) that weigh
 * hundreds of kilobytes and have tripped bundler tree-shake edge cases when
 * inlined. Everything here is a pure data builder with no host-state, React,
 * or TypeBox dependency. Types are erased at bundle time, so plugin authors
 * still get the full typed surface from their editor.
 */
export { defineModule } from './builders/defineModule'
export { control } from './builders/controls'
export { escapeHtml, html, raw, safeUrl } from './builders/html'
export { sitePluginRoute } from './sitePluginRoute'

// Type-only re-exports — free at runtime, complete in the editor.
export type * from './modules'
export type * from './types'
