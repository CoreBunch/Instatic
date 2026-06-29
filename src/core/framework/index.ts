/**
 * Public barrel for the Core Framework engine.
 *
 * Everything outside `src/core/framework/` imports from `@core/framework`.
 * Internal files within this module import from each other via relative paths.
 *
 * The persisted data schemas live in `@core/framework-schema` (a pure leaf the
 * page tree also depends on); import those from there, not from this barrel.
 */

export * from './scale'
export * from './scaleModule'
export * from './preferences'
export * from './cssVariables'
export * from './colors'
export * from './typography'
export * from './spacing'
export * from './defaults'
export * from './coreFrameworkPreset'
export * from './generate'
export * from './changeImpact'
export * from './describe'
