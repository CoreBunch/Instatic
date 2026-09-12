/**
 * Session-local draft module-pack preview state — which module ids are
 * currently registered from a site plugin DRAFT build (not the active
 * revision). The module inserter reads this to render the `Draft` badge;
 * nothing here is ever persisted or server-side.
 */
import { useSyncExternalStore } from 'react'

const draftModuleIds = new Set<string>()
const listeners = new Set<() => void>()

export function markDraftPreviewModules(moduleIds: readonly string[]): void {
  for (const id of moduleIds) draftModuleIds.add(id)
  for (const listener of listeners) listener()
}

export function clearDraftPreviewModules(moduleIds: readonly string[]): void {
  for (const id of moduleIds) draftModuleIds.delete(id)
  for (const listener of listeners) listener()
}

export function isDraftPreviewModule(moduleId: string): boolean {
  return draftModuleIds.has(moduleId)
}

function onDraftPreviewModulesChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reactive read for the inserter — re-renders when the draft pack loads or unloads. */
export function useIsDraftPreviewModule(moduleId: string): boolean {
  return useSyncExternalStore(onDraftPreviewModulesChange, () => isDraftPreviewModule(moduleId))
}
