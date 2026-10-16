/**
 * Public barrel for the Core fonts engine.
 *
 * Everything outside `src/core/fonts/` imports from `@core/fonts`.
 * Internal files within this module import from each other via relative paths.
 */

export * from './types'
export * from './schemas'
export * from './variants'
export * from './tokens'
export * from './roles'
export * from './css'
export * from './googleDirectory'
export * from './preview'
export * from './describe'
