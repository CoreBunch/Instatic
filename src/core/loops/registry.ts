/**
 * LoopSourceRegistry — singleton holding registered LoopEntitySources.
 *
 * Built-in sources (data.rows, site.pages, site.media) self-register
 * on import via `src/core/loops/sources/index.ts`. Plugins register
 * additional sources through the plugin SDK: on the server as prefetched
 * sources backed by the plugin's worker, in the editor as `remote`
 * descriptors (`./remoteSources.ts`).
 *
 * Mirrors the ModuleRegistry shape in `src/core/module-engine/registry.ts`
 * deliberately — same lookup semantics, same namespacing rules. IDs MUST
 * be of the form `<namespace>.<name>` so plugin sources can't shadow
 * built-ins. The architecture test `loop-source-id-format.test.ts`
 * enforces this rule across all registered sources.
 */

import type { ILoopSourceRegistry, LoopEntitySource } from './types'

class LoopSourceRegistry implements ILoopSourceRegistry {
  private readonly _sources = new Map<string, LoopEntitySource>()
  private readonly _listeners = new Set<() => void>()
  private _snapshot: readonly LoopEntitySource[] = []

  private changed(): void {
    // A new array on every change: a reader that holds a snapshot can tell a
    // changed set from an unchanged one by identity alone.
    this._snapshot = Array.from(this._sources.values())
    for (const listener of this._listeners) listener()
  }

  private validateId(id: string): void {
    if (!id || !id.includes('.')) {
      throw new Error(
        `[LoopSourceRegistry] Invalid source ID "${id}". ` +
          `IDs must be namespaced: "namespace.source-name" (e.g. "data.rows").`,
      )
    }
  }

  register(source: LoopEntitySource): void {
    this.validateId(source.id)
    if (this._sources.has(source.id)) {
      throw new Error(
        `[LoopSourceRegistry] Source "${source.id}" is already registered. ` +
          `Use registerOrReplace() to intentionally overwrite.`,
      )
    }
    this._sources.set(source.id, source)
    this.changed()
  }

  registerOrReplace(source: LoopEntitySource): void {
    this.validateId(source.id)
    this._sources.set(source.id, source)
    this.changed()
  }

  unregister(id: string): void {
    if (this._sources.delete(id)) this.changed()
  }

  get(id: string): LoopEntitySource | undefined {
    return this._sources.get(id)
  }

  getOrThrow(id: string): LoopEntitySource {
    const source = this._sources.get(id)
    if (!source) {
      throw new Error(
        `[LoopSourceRegistry] Source "${id}" is not registered. ` +
          `Ensure the source module is imported before use.`,
      )
    }
    return source
  }

  has(id: string): boolean {
    return this._sources.has(id)
  }

  list(): LoopEntitySource[] {
    return Array.from(this._sources.values())
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener)
    return () => {
      this._listeners.delete(listener)
    }
  }

  getSnapshot = (): readonly LoopEntitySource[] => this._snapshot

  get size(): number {
    return this._sources.size
  }
}

export const loopSourceRegistry = new LoopSourceRegistry()
