/**
 * Shell content equality — shared by the transactional save (server skips
 * the shell write + seq stamp when nothing changed) and the editor's
 * remote-apply echo detection (identical shells are bookkeeping-only, no
 * undo-history reset).
 *
 * `updatedAt` is deliberately EXCLUDED: the editor bumps it on every historic
 * mutation (page edits included), so treating it as content would turn every
 * save into a "shell change" and destroy the shell seq as a conflict signal.
 * The stored shell's `updatedAt` consequently means "when shell CONTENT last
 * changed".
 */
import type { SiteShell } from '@core/page-tree'
import { deepEqual } from '@core/utils/deepEqual'

export function shellsEqual(a: SiteShell, b: SiteShell): boolean {
  return deepEqual({ ...a, updatedAt: 0 }, { ...b, updatedAt: 0 })
}
