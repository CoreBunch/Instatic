/**
 * Store isolation for the test suite.
 *
 * Every app store is a module-level Zustand singleton, so one instance is shared
 * by every test file in the run. `setState(partial)` MERGES, which means a file
 * that seeds a store with a hand-written partial silently inherits every field
 * it did not mention from whichever file happened to run before it. `bun test`
 * walks test files in filesystem order, and that order differs between APFS and
 * ext4, so the inherited value differs between a local run and CI.
 *
 * That is not hypothetical. A leaked `canvasView: 'live'` made
 * `canvasFormControls.test.tsx` fail on nearly every CI run for weeks while
 * passing on every local run: in live view `CanvasRoot` renders a single preview
 * frame where native form-control suppression is deliberately off, so the test
 * asserted design-mode behaviour against a preview frame.
 *
 * `resetAppStores()` runs from a global `beforeEach` in the test preload
 * (`src/__tests__/setup.ts`), so every test starts from the state the app boots
 * with and a test file only has to name what it actually wants. Add any new
 * global store to `RESETTERS` below.
 */

import { useEditorStore } from '@site/store/store'
import { useAdminUi } from '@admin/state/adminUi'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'

interface ResettableStore<T> {
  getState: () => T
  setState: (partial: Partial<T>) => void
}

/**
 * Capture a store's pristine state and return a function that restores it.
 *
 * The snapshot is taken when THIS module is first imported, which the preload
 * does before any test file runs. A lazy first import from inside a test would
 * capture whatever the previous file left behind, which is the very bug this
 * module exists to prevent.
 */
function pristineResetter<T extends object>(store: ResettableStore<T>): () => void {
  const pristine = { ...store.getState() }
  return () => store.setState(pristine)
}

const RESETTERS = [
  pristineResetter(useEditorStore),
  pristineResetter(useAdminUi),
  pristineResetter(useWorkspaceLayout),
]

/** Restore every app store to the state it had before the suite started. */
export function resetAppStores(): void {
  for (const reset of RESETTERS) reset()
}
