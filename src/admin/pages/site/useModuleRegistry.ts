/**
 * useModuleDefinition / useModuleList — React bindings for the module
 * registry.
 *
 * The module registry (`@core/module-engine`) is a plain mutable singleton,
 * not a React store. Plugin module packs register asynchronously after the
 * editor mounts (`useInstalledEditorPlugins` → dynamic import →
 * `activatePluginModulePack`), so any component that reads
 * `registry.get()`/`registry.list()` during render can execute before the
 * plugin modules exist — layer rows fall back to raw module ids, tag pills
 * and icons go missing, the module picker omits plugin modules.
 *
 * IMPORTANT — React Compiler interaction: it is NOT enough to subscribe to
 * the registry and keep calling `registry.get(...)` in render. The compiler
 * memoizes `registry.get(node.moduleId)` keyed on `node.moduleId` (it
 * assumes module-level singletons are immutable), so a subscription-driven
 * re-render still replays the stale cached lookup. The resolved value must
 * flow OUT of a `useSyncExternalStore` snapshot so the data dependency is
 * visible to the compiler. That's what these hooks do — always read module
 * metadata through them in render paths. Event handlers can keep using the
 * raw singleton; they always execute against live state.
 */
import { useSyncExternalStore } from 'react'
import { registry, type AnyModuleDefinition } from '@core/module-engine'

const subscribe = (listener: () => void) => registry.subscribe(listener)

/**
 * Resolve one module definition, re-rendering when the registry changes.
 * Accepts `undefined` so callers with an optional node can call the hook
 * unconditionally (hooks-order rule) and guard afterwards.
 */
export function useModuleDefinition(
  moduleId: string | undefined,
): AnyModuleDefinition | undefined {
  // `Map.get` returns a stable reference per (id, registration), so the
  // snapshot only changes identity when the module is actually (re)registered.
  return useSyncExternalStore(
    subscribe,
    () => (moduleId ? registry.get(moduleId) : undefined),
    () => (moduleId ? registry.get(moduleId) : undefined),
  )
}

// `registry.list()` builds a fresh array per call; useSyncExternalStore
// requires a stable snapshot between changes, so cache one array per
// registry generation.
let listCache: { generation: number; list: AnyModuleDefinition[] } | null = null
function listSnapshot(): AnyModuleDefinition[] {
  const generation = registry.generation()
  if (!listCache || listCache.generation !== generation) {
    listCache = { generation, list: registry.list() }
  }
  return listCache.list
}

/**
 * All registered modules, re-rendering when the registry changes. The array
 * identity is stable per registry generation, so downstream derivations
 * (grouping, `Map` indexes, picker item lists) recompute exactly when the
 * registry changes.
 */
export function useModuleList(): AnyModuleDefinition[] {
  return useSyncExternalStore(subscribe, listSnapshot, listSnapshot)
}
