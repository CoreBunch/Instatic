/**
 * LoopSourceRegistry — singleton holding registered LoopEntitySources.
 *
 * Built-in sources (data.rows, site.pages, site.media) self-register
 * on import via `src/core/loops/sources/index.ts`. Plugins register
 * additional sources through the plugin SDK.
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
  }

  registerOrReplace(source: LoopEntitySource): void {
    this.validateId(source.id)
    this._sources.set(source.id, source)
  }

  unregister(id: string): void {
    this._sources.delete(id)
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

  get size(): number {
    return this._sources.size
  }
}

export const loopSourceRegistry = new LoopSourceRegistry()
