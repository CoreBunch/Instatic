/**
 * The loop sources the editor knows of, re-read whenever the set changes.
 *
 * Built-in sources are registered before the first render. A plugin's sources
 * arrive later, from the server, and come and go as plugins are enabled and
 * disabled. A component that reads the registry through these hooks follows
 * those changes; one that reads `loopSourceRegistry` directly would keep the
 * list it saw when it first rendered.
 *
 * Every hook derives its answer from the snapshot `useSyncExternalStore`
 * returns. The snapshot is a new array on each change, so it is a real
 * dependency of whatever is computed from it: the React Compiler recomputes
 * when it changes and at no other time.
 */
import { useSyncExternalStore } from 'react'
import {
  loopSourceRegistry,
  remoteLoopSourcesSynced,
  subscribeRemoteLoopSourcesSynced,
  type LoopEntitySource,
} from '@core/loops'

/** Built-in sources first, then plugins' sources, each in registration order. */
export function useLoopSources(): LoopEntitySource[] {
  const sources = useSyncExternalStore(loopSourceRegistry.subscribe, loopSourceRegistry.getSnapshot)
  return [
    ...sources.filter((source) => source.kind !== 'remote'),
    ...sources.filter((source) => source.kind === 'remote'),
  ]
}

/** One source by id, or `undefined` while no such source is registered. */
export function useLoopSource(sourceId: string | null | undefined): LoopEntitySource | undefined {
  const sources = useSyncExternalStore(loopSourceRegistry.subscribe, loopSourceRegistry.getSnapshot)
  return sourceId ? sources.find((source) => source.id === sourceId) : undefined
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
