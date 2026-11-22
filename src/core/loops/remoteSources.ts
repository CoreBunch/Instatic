/**
 * Plugin loop sources in the editor.
 *
 * A plugin registers its sources inside the server process, where `fetch`
 * can run in the plugin's sandbox. The editor is another process: it gets
 * the descriptors from the server and registers each as a `remote` source,
 * so the picker, the field bindings and the import warnings read plugin
 * sources from the same registry as built-in ones.
 */

import { loopSourceRegistry } from './registry'
import type { RemoteLoopSource } from './descriptorSchema'

// Whether the server's list has arrived at least once. Until it has, a loop
// on a plugin source is waiting, not broken, and must not be reported as
// "source unavailable".
let synced = false
const syncedListeners = new Set<() => void>()

export function subscribeRemoteLoopSourcesSynced(listener: () => void): () => void {
  syncedListeners.add(listener)
  return () => {
    syncedListeners.delete(listener)
  }
}

export function remoteLoopSourcesSynced(): boolean {
  return synced
}

/**
 * Make the registry's remote sources exactly `sources`: new ones are added,
 * changed ones replaced, and ones no longer listed (the plugin was disabled
 * or removed) dropped. In-process sources are never touched, and a remote
 * descriptor cannot take an in-process source's id.
 */
export function replaceRemoteLoopSources(sources: readonly RemoteLoopSource[]): void {
  const incoming = new Set(sources.map((source) => source.id))
  for (const existing of loopSourceRegistry.list()) {
    if (existing.kind === 'remote' && !incoming.has(existing.id)) {
      loopSourceRegistry.unregister(existing.id)
    }
  }
  for (const source of sources) {
    const existing = loopSourceRegistry.get(source.id)
    if (existing && existing.kind !== 'remote') continue
    const next = { ...source, kind: 'remote' as const }
    // The same descriptor again (the list is refetched whenever the tab is
    // shown) changes nothing and tells nobody.
    if (existing && JSON.stringify(existing) === JSON.stringify(next)) continue
    loopSourceRegistry.registerOrReplace(next)
  }
  if (!synced) {
    synced = true
    for (const listener of syncedListeners) listener()
  }
}

/** Back to the state before the first sync: no remote sources, list not yet arrived. For tests. */
export function resetRemoteLoopSourcesForTests(): void {
  for (const existing of loopSourceRegistry.list()) {
    if (existing.kind === 'remote') loopSourceRegistry.unregister(existing.id)
  }
  if (synced) {
    synced = false
    for (const listener of syncedListeners) listener()
  }
}
