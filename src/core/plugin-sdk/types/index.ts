/**
 * Plugin SDK types — barrel re-exporting every focused submodule. The
 * submodules are split by concern (manifest, lifecycle, permissions,
 * editor surfaces, server surfaces, media tiers, etc.) so each file owns
 * one responsibility. Callers should import from the top-level SDK barrel
 * (`@core/plugin-sdk`) which forwards this barrel and the runtime modules
 * (capabilities, guards, modules, storageSchemas, builders).
 */

// Sandbox global augmentations — side-effect import so the `declare global`
// block is preserved when the SDK is consumed.
import './sandboxGlobals'

export * from './apiVersion'
export * from './permissions'
export * from './lifecycle'
export * from './frontend'
export * from './publisher'
export * from './resources'
export * from './adminPages'
export * from './manifest'
export * from './installedPlugin'
export * from './commands'
export * from './panels'
export * from './canvasOverlays'
export * from './dashboardWidgets'
export * from './editorApi'
export * from './routes'
export * from './hooks'
export * from './loops'
export * from './settings'
export * from './schedule'
export * from './media'
export * from './serverApi'
export * from './content'
