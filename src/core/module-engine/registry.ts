import type { IModuleRegistry, AnyModuleDefinition, ModuleDefinition } from './types'

/**
 * ModuleRegistry — Singleton that holds all registered ModuleDefinitions.
 *
 * Base modules self-register via `src/modules/base/index.ts` on app boot.
 * Plugin modules are registered dynamically when installed/loaded.
 *
 * The registry holds the type-erased AnyModuleDefinition shape (props typed as
 * Record<string, unknown>). Each module's narrow TProps is visible at the
 * definition site; runtime callers receive props as a generic record. The
 * narrow→erased cast happens once at this boundary so user code never needs
 * to widen its types.
 */
type RegistryListener = () => void

class ModuleRegistry implements IModuleRegistry {
  private readonly _modules = new Map<string, AnyModuleDefinition>()
  private readonly _listeners = new Set<RegistryListener>()
  private _generation = 0

  /**
   * One controlled point of TProps→Record<string, unknown> erasure.
   * The cast is sound: every ModuleDefinition<T> is structurally a superset of
   * AnyModuleDefinition at runtime — its render/component just expect a
   * narrower props shape than the registry can statically promise.
   */
  private erase<T extends Record<string, unknown>>(
    definition: ModuleDefinition<T>,
  ): AnyModuleDefinition {
    return definition as unknown as AnyModuleDefinition
  }

  /**
   * Enforce the `publishBehavior: 'transparent'` contract at registration: a
   * transparent module contributes nothing on its own, so its `render()` MUST
   * return empty HTML. Catching this here means a future transparent module
   * whose render is not actually empty fails loudly at boot instead of silently
   * leaking markup into the published page.
   *
   * Modules that have migrated to `htmlContract` (no `render`) are skipped —
   * the transparent contract is enforced via the contract's `attributes()`
   * returning empty, which the publisher checks at render time.
   */
  private validatePublishBehavior<T extends Record<string, unknown>>(
    definition: ModuleDefinition<T>,
  ): void {
    if (definition.publishBehavior !== 'transparent') return
    if (!definition.render) return
    const output = definition.render(definition.defaults, [])
    if (output.html !== '' || (output.css ?? '') !== '') {
      throw new Error(
        `[ModuleRegistry] Module "${definition.id}" declares publishBehavior:'transparent' ` +
          `but its render() returned non-empty output. Transparent modules must render nothing.`,
      )
    }
  }

  /**
   * Subscribe to registration changes. Used by the editor canvas to
   * re-render when plugin module packs activate after the canvas has
   * already mounted. Returns an unsubscribe function.
   */
  subscribe(listener: RegistryListener): () => void {
    this._listeners.add(listener)
    return () => {
      this._listeners.delete(listener)
    }
  }

  /**
   * Monotonic counter that bumps on every register / unregister. Pair with
   * `subscribe` (e.g. in `useSyncExternalStore`) so React-side consumers can
   * cheaply detect registry changes without re-snapshotting the whole
   * module list.
   */
  generation(): number {
    return this._generation
  }

  private emitChange(): void {
    this._generation += 1
    for (const listener of this._listeners) listener()
  }

  register<T extends Record<string, unknown>>(definition: ModuleDefinition<T>): void {
    if (!definition.id || !definition.id.includes('.')) {
      throw new Error(
        `[ModuleRegistry] Invalid module ID "${definition.id}". ` +
          `IDs must be namespaced: "namespace.module-name" (e.g. "base.text").`
      )
    }
    if (this._modules.has(definition.id)) {
      throw new Error(
        `[ModuleRegistry] Module "${definition.id}" is already registered. ` +
          `Use registerOrReplace() to intentionally overwrite.`
      )
    }
    this.validatePublishBehavior(definition)
    this._modules.set(definition.id, this.erase(definition))
    this.emitChange()
  }

  registerOrReplace<T extends Record<string, unknown>>(definition: ModuleDefinition<T>): void {
    if (!definition.id || !definition.id.includes('.')) {
      throw new Error(
        `[ModuleRegistry] Invalid module ID "${definition.id}".`
      )
    }
    this.validatePublishBehavior(definition)
    this._modules.set(definition.id, this.erase(definition))
    this.emitChange()
  }

  unregister(id: string): void {
    if (this._modules.delete(id)) this.emitChange()
  }

  get(id: string): AnyModuleDefinition | undefined {
    return this._modules.get(id)
  }

  getOrThrow(id: string): AnyModuleDefinition {
    const mod = this._modules.get(id)
    if (!mod) {
      throw new Error(
        `[ModuleRegistry] Module "${id}" is not registered. ` +
          `Ensure the module is imported and registered before use.`
      )
    }
    return mod
  }

  has(id: string): boolean {
    return this._modules.has(id)
  }

  list(): AnyModuleDefinition[] {
    return Array.from(this._modules.values())
  }

  listByCategory(): Record<string, AnyModuleDefinition[]> {
    const result: Record<string, AnyModuleDefinition[]> = {}
    for (const mod of this._modules.values()) {
      const cat = mod.category
      if (!result[cat]) result[cat] = []
      result[cat].push(mod)
    }
    return result
  }

  /**
   * Find the first module whose `htmlContract.claimSelector` matches the
   * given DOM element. Modules are tested in registration order; the first
   * match wins. Used by the HTML importer to attach a `moduleOverlay` to
   * a DOM-native node when an element matches a module's claim.
   *
   * Returns `undefined` when no module claims the element.
   */
  getByClaimSelector(el: Element): AnyModuleDefinition | undefined {
    for (const mod of this._modules.values()) {
      const selector = mod.htmlContract?.claimSelector
      if (selector && el.matches(selector)) return mod
    }
    return undefined
  }

  /**
   * Return all modules whose `htmlContract.tag` (static string) matches the
   * given HTML tag name. Used as a fallback when no `claimSelector` matches
   * but the tag name is known.
   */
  getByHtmlTag(tag: string): AnyModuleDefinition[] {
    const result: AnyModuleDefinition[] = []
    for (const mod of this._modules.values()) {
      const contractTag = mod.htmlContract?.tag
      if (typeof contractTag === 'string' && contractTag === tag) result.push(mod)
    }
    return result
  }

  get size(): number {
    return this._modules.size
  }
}

export const registry = new ModuleRegistry()
