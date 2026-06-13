/**
 * Host-side registry of installed media variant delegates (Tier 3 of the
 * media plugin surface).
 *
 * Distinct from `mediaStorageRegistry` because:
 *   • A delegate is purely declarative — a URL template + widths + formats.
 *     No callbacks, no round-trip into the sandbox at render time.
 *   • Election is a SINGLETON (one delegate wins per host), persisted in
 *     `active_media_variant_delegate` — see
 *     `server/repositories/mediaStorageAdapters.ts`.
 *
 * Why a registry then? Two reasons:
 *   1. The admin "Pick a delegate" UI lists every installed delegate the
 *     site owner can choose from.
 *   2. On plugin disable / uninstall, the host needs to remove the
 *     delegate from the picker AND, if it was the elected one, clear the
 *     row so the host falls back to the local sharp ladder.
 *
 * The registry is in-memory and rebuilt on every plugin (re-)activation —
 * see the call sites in `server/plugins/pluginWorkerHost.ts`.
 */

interface MediaVariantDelegateRecord {
  id: string
  /** namespaced under the plugin id; used by host code to tear down. */
  pluginId: string
  variantUrlTemplate: string
  widths: ReadonlyArray<number>
  formats: ReadonlyArray<'webp' | 'jpeg' | 'avif'>
}

class MediaVariantDelegateRegistry {
  private byId = new Map<string, MediaVariantDelegateRecord>()

  register(record: MediaVariantDelegateRecord): void {
    if (!record.id) {
      throw new Error('[mediaVariantDelegateRegistry] delegate id is required')
    }
    if (!record.id.startsWith(`${record.pluginId}.`)) {
      throw new Error(
        `[mediaVariantDelegateRegistry] delegate id "${record.id}" must start with the plugin id "${record.pluginId}."`,
      )
    }
    this.byId.set(record.id, record)
  }

  unregisterPlugin(pluginId: string): void {
    const prefix = `${pluginId}.`
    for (const id of this.byId.keys()) {
      if (id === pluginId || id.startsWith(prefix)) {
        this.byId.delete(id)
      }
    }
  }

  /** Snapshot every installed delegate — admin UI surface. */
  list(): MediaVariantDelegateRecord[] {
    return Array.from(this.byId.values())
  }

  /** Returns the delegate record for an id, or `null` if not installed. */
  get(id: string): MediaVariantDelegateRecord | null {
    return this.byId.get(id) ?? null
  }

  /** Test-only reset. */
  __reset(): void {
    this.byId.clear()
  }
}

export const mediaVariantDelegateRegistry = new MediaVariantDelegateRegistry()
