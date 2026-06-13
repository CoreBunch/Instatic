/**
 * Host-side media storage adapter registry.
 *
 * Every media write goes through this singleton. The built-in local-disk
 * adapter is registered at boot and handles every role by default; plugins
 * with the `media.storage.adapter` permission can register additional
 * adapters via `api.cms.media.registerStorageAdapter(...)` (Phase B — the
 * QuickJS bridge that exposes that surface).
 *
 * Election is per-role and persisted in `active_media_storage_adapter`
 * (see `server/repositories/mediaStorageAdapters.ts`). An adapter that
 * isn't elected for any role still lives in the registry — the admin UI
 * lists every installed adapter so the user can pick.
 *
 * Two-phase upload contract:
 *
 *   1. `adapter.beginWrite(input)` — adapter issues a signed `MediaStorageUploadPlan`.
 *   2. Host streams bytes directly to the URLs in the plan via Bun's
 *      native `fetch` (gated by the same `networkAllowedHosts` allowlist
 *      the sandbox already enforces).
 *   3. `adapter.finalizeWrite({ storagePath, uploadReceipts })` — adapter
 *      confirms the upload landed and returns the final shape persisted
 *      on the DB row.
 *
 * On any step failure, the host calls `adapter.abortWrite({ storagePath })`
 * so partial uploads don't pile up.
 *
 * Bytes NEVER cross the QuickJS sandbox boundary. That's the core
 * invariant — a plugin adapter that needed bytes would hit the 64 MB
 * heap ceiling on its first 50 MB video upload.
 */

import type {
  MediaAssetRole,
  MediaStorageAdapter,
  MediaStorageBeginWriteInput,
  MediaStorageFinalizeWriteInput,
  MediaStorageUploadPlan,
  MediaStorageVerifyResult,
  MediaStorageWriteResult,
} from '@core/plugin-sdk'

// ---------------------------------------------------------------------------
// Local-disk built-in adapter
// ---------------------------------------------------------------------------

/**
 * Sentinel id for the built-in local-disk adapter. The DB stores `''` for
 * "no adapter elected → fall back to local disk"; we use that same empty
 * string here so the dispatch logic doesn't carry a second sentinel.
 */
const LOCAL_DISK_ADAPTER_ID = '' as const

/**
 * Synthetic step protocol the local-disk adapter uses to communicate with
 * its peer executor in `mediaUploadExecutor.ts`. A real plugin adapter
 * would return `'PUT' | 'POST'` URLs; the local-disk adapter returns this
 * sentinel so the executor knows to use `writeFile` instead of `fetch`.
 *
 * The TS surface keeps the adapter contract pure (only declares `'PUT' | 'POST'`);
 * this constant is internal to the host's executor.
 */
export const LOCAL_DISK_STEP_METHOD = 'LOCAL' as const

interface LocalDiskAdapterOptions {
  /** Absolute path to the uploads directory. Required at boot. */
  uploadsDir: string
}

/**
 * Build the built-in local-disk adapter. The plan it returns carries a
 * single `'LOCAL'` step the host executor recognises and short-circuits
 * with a direct `writeFile`. Reads are served by the host's existing
 * `/uploads/*` static handler — `getReadUrl` is undefined because the
 * `servingMode` is `'public-url'` AND the public URL is already
 * resolved at `finalizeWrite` time.
 */
function buildLocalDiskAdapter(options: LocalDiskAdapterOptions): MediaStorageAdapter {
  return {
    id: LOCAL_DISK_ADAPTER_ID,
    label: 'Local disk',
    roles: ['original', 'variant', 'avatar', 'font', 'plugin-pack'],
    servingMode: 'public-url',
    beginWrite: async (input: MediaStorageBeginWriteInput): Promise<MediaStorageUploadPlan> => {
      // No remote step — the executor writes via `node:fs/promises`.
      // The "URL" field carries the absolute on-disk path so the executor
      // doesn't need to re-derive it from `storagePath` + `uploadsDir`.
      const { join } = await import('node:path')
      const absolutePath = join(options.uploadsDir, input.suggestedStoragePath)
      return {
        storagePath: input.suggestedStoragePath,
        steps: [
          {
            // `LOCAL` is recognised by `mediaUploadExecutor.ts`. The type
            // assertion here is the one place the sentinel leaks into the
            // SDK type — see the LOCAL_DISK_STEP_METHOD constant comment.
            method: LOCAL_DISK_STEP_METHOD as unknown as 'PUT',
            url: `file://${absolutePath}`,
            headers: {},
          },
        ],
        // Local writes have no time pressure; pick a far-future expiry so
        // the executor's pre-flight check is always satisfied.
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      }
    },
    finalizeWrite: async (
      input: MediaStorageFinalizeWriteInput,
    ): Promise<MediaStorageWriteResult> => {
      return {
        publicUrl: `/uploads/${input.storagePath}`,
      }
    },
    abortWrite: async ({ storagePath }) => {
      const { rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      // Idempotent — `force: true` swallows ENOENT.
      await rm(join(options.uploadsDir, storagePath), { force: true })
    },
    delete: async (storagePath: string) => {
      const { rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      await rm(join(options.uploadsDir, storagePath), { force: true })
    },
    verify: async (): Promise<MediaStorageVerifyResult> => {
      const { stat } = await import('node:fs/promises')
      try {
        const info = await stat(options.uploadsDir)
        if (!info.isDirectory()) {
          return { ok: false, reason: 'uploadsDir is not a directory' }
        }
        return { ok: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, reason: `Cannot stat uploadsDir: ${message}` }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Registry singleton
// ---------------------------------------------------------------------------

class MediaStorageRegistry {
  private adapters = new Map<string, MediaStorageAdapter>()
  private localDiskReady = false

  /**
   * Wire the built-in local-disk adapter. Called once per process boot from
   * `server/index.ts` with the resolved uploads dir. Idempotent — subsequent
   * calls update the uploads dir in place (test environments cycle this).
   */
  configureLocalDisk(options: LocalDiskAdapterOptions): void {
    this.adapters.set(LOCAL_DISK_ADAPTER_ID, buildLocalDiskAdapter(options))
    this.localDiskReady = true
  }

  /**
   * Register a plugin adapter. Called by the QuickJS host bridge when a
   * plugin invokes `api.cms.media.registerStorageAdapter(...)`. Phase B
   * wires this side.
   */
  register(adapter: MediaStorageAdapter): void {
    if (!adapter.id) {
      throw new Error('[mediaStorageRegistry] Adapter id is required')
    }
    if (adapter.id === LOCAL_DISK_ADAPTER_ID) {
      throw new Error(
        `[mediaStorageRegistry] Adapter id "" is reserved for the built-in local-disk adapter`,
      )
    }
    this.adapters.set(adapter.id, adapter)
  }

  /**
   * Tear down every adapter registered under a given plugin id. Called on
   * plugin disable / uninstall. The local-disk adapter is never affected.
   */
  unregisterPlugin(pluginId: string): void {
    const prefix = `${pluginId}.`
    for (const id of this.adapters.keys()) {
      if (id === LOCAL_DISK_ADAPTER_ID) continue
      if (id === pluginId || id.startsWith(prefix)) {
        this.adapters.delete(id)
      }
    }
  }

  /**
   * Resolve an adapter by id. Returns the local-disk adapter for `''`. If
   * the requested adapter id is registered but doesn't claim the role,
   * returns `null` so the caller can fall back gracefully.
   *
   * Returns `null` for an unknown id (e.g. an adapter elected for a plugin
   * that's currently uninstalled) — the dispatch layer surfaces this as a
   * 503 to the upload handler rather than silently rerouting to local disk.
   */
  resolve(adapterId: string, role: MediaAssetRole): MediaStorageAdapter | null {
    if (!this.localDiskReady) {
      throw new Error(
        '[mediaStorageRegistry] Local-disk adapter not configured. Call configureLocalDisk() at boot.',
      )
    }
    const adapter = this.adapters.get(adapterId)
    if (!adapter) return null
    if (!adapter.roles.includes(role)) return null
    return adapter
  }

  /**
   * Resolve an adapter by id with no role gate. Used by READ-side
   * dispatch — the asset row pins its adapter id, and we don't re-check
   * role at read time (the role was validated at upload time).
   */
  resolveForRead(adapterId: string): MediaStorageAdapter | null {
    if (!this.localDiskReady) {
      throw new Error(
        '[mediaStorageRegistry] Local-disk adapter not configured. Call configureLocalDisk() at boot.',
      )
    }
    return this.adapters.get(adapterId) ?? null
  }

  /** Snapshot every registered adapter — admin UI surface. */
  list(): MediaStorageAdapter[] {
    return Array.from(this.adapters.values())
  }

  /** Test-only reset. */
  __reset(): void {
    this.adapters.clear()
    this.localDiskReady = false
  }
}

export const mediaStorageRegistry = new MediaStorageRegistry()

