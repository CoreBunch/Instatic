// ---------------------------------------------------------------------------
// Barrel — the canonical public API for the saved-layouts module.
// Everything outside `src/core/layouts/` MUST import from `@core/layouts`.
// ---------------------------------------------------------------------------

export {
  SavedLayoutSchema,
  parseSavedLayout,
  layoutNameError,
} from './schemas'
export type { SavedLayout } from './schemas'
