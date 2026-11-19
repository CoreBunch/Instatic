/**
 * The loop sources the editor knows of, re-read whenever the set changes.
 *
 * Built-in sources are registered before the first render. A plugin's sources
 * arrive later, from the server, and come and go as plugins are enabled and
 * disabled. A component that reads the registry through this hook follows
 * those changes; one that reads `loopSourceRegistry` directly would keep the
 * list it saw when it first rendered.
 */
import { useSyncExternalStore } from 'react'
import { remoteLoopSourcesSynced, subscribeRemoteLoopSourcesSynced } from '@core/loops'
import { loopSourceRegistry } from '@core/loops/registry'
import type { LoopEntitySource } from '@core/loops/types'

/** Built-in sources first, then plugins' sources, each in registration order. */
export function useLoopSources(): LoopEntitySource[] {
  useSyncExternalStore(loopSourceRegistry.subscribe, loopSourceRegistry.getVersion)
  const sources = loopSourceRegistry.list()
  return [
    ...sources.filter((source) => source.kind !== 'remote'),
    ...sources.filter((source) => source.kind === 'remote'),
  ]
}

/** One source by id, or `undefined` while no such source is registered. */
export function useLoopSource(sourceId: string | null | undefined): LoopEntitySource | undefined {
  useSyncExternalStore(loopSourceRegistry.subscribe, loopSourceRegistry.getVersion)
  return sourceId ? loopSourceRegistry.get(sourceId) : undefined
}

/**
 * Whether a source id that is not registered is really missing. False until
 * the server's list of plugin sources has arrived: before that, a loop on a
 * plugin source is still waiting for it.
 */
export function useLoopSourceMissing(sourceId: string): boolean {
  const source = useLoopSource(sourceId)
  const synced = useSyncExternalStore(subscribeRemoteLoopSourcesSynced, remoteLoopSourcesSynced)
  return sourceId !== '' && !source && synced
}

/** How a source reads in the picker: a plugin's source carries the plugin's name. */
export function loopSourceLabel(source: LoopEntitySource): string {
  return source.kind === 'remote' ? `${source.provider.pluginName}: ${source.label}` : source.label
}
