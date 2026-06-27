import type {
  PluginRecord,
  StorageListOptions,
  StorageListResult,
} from '../storageSchemas'
import type {
  ContentEntry,
  ContentListOptions,
  ContentListResult,
  ContentSearchResult,
  ContentTableSchema,
  ContentTableSummary,
  ContentTreeOperation,
  CreateContentEntryInput,
  CreateContentTableInput,
  PublishedSnapshot,
  TreeMutateResult,
  UpdateContentEntryInput,
} from '../contentSchemas'
import type { ServerPluginHooksApi } from './hooks'
import type { LoopEntitySource } from './loops'
import type { ServerPluginMediaApi } from './media'
import type { PluginMigrationContext } from './lifecycle'
import type { PluginPermission } from './permissions'
import type { ServerPluginRouteHandler } from './routes'
import type { ServerPluginScheduleApi } from './schedule'
import type { ServerPluginSettingsApi } from './settings'

// ---------------------------------------------------------------------------
// ServerPluginApi — full API surface available to server entrypoints
// ---------------------------------------------------------------------------

export interface ServerPluginApi {
  plugin: {
    id: string
    version: string
    permissions: PluginPermission[]
    log: (...args: unknown[]) => void
    /**
     * Build a public URL for a static file the plugin ships in its zip.
     *
     * Plugin packages can include any number of static assets (images,
     * CSS, fonts, JSON, …) alongside the bundled JS entrypoints. They are
     * extracted to `/uploads/plugins/<id>/<version>/<path>` at install
     * time and served by the host's static handler.
     *
     * This helper returns the canonical URL for the given package-relative
     * path. It works inside the sandbox AND from admin / editor / frontend
     * bundles (which receive the same context through their host wrappers).
     *
     * @example
     *   const url = api.plugin.assetUrl('icon.svg')
     *   // → "/uploads/plugins/acme.template/1.0.0/icon.svg"
     */
    assetUrl: (path: string) => string
  }
  cms: {
    /**
     * Register backend HTTP routes scoped under
     * `/admin/api/cms/plugins/:id/runtime/<path>`. Three access shapes:
     *
     *   api.cms.routes.get(path, capability, handler)
     *       Standard gated route — caller must hold the named core capability
     *       (e.g. 'content.manage'). Most plugin endpoints use this form.
     *
     *   api.cms.routes.authenticated.get(path, handler)
     *       Any logged-in admin user — session cookie required, no specific
     *       capability check. Useful for read-only "currently-logged-in user"
     *       endpoints (e.g. a per-user dashboard payload).
     *
     *   api.cms.routes.public.get(path, handler)
     *       Anonymous-callable — NO authentication. Plugin must additionally
     *       declare `cms.routes.public` in its manifest permissions so the
     *       install consent dialog flags the plugin to the operator. Use for
     *       webhook receivers, public read APIs (sitemaps, robots, search),
     *       and frontend tracker ingest endpoints.
     */
    routes: {
      get: (path: string, capability: string, handler: ServerPluginRouteHandler) => void
      post: (path: string, capability: string, handler: ServerPluginRouteHandler) => void
      patch: (path: string, capability: string, handler: ServerPluginRouteHandler) => void
      delete: (path: string, capability: string, handler: ServerPluginRouteHandler) => void
      authenticated: {
        get: (path: string, handler: ServerPluginRouteHandler) => void
        post: (path: string, handler: ServerPluginRouteHandler) => void
        patch: (path: string, handler: ServerPluginRouteHandler) => void
        delete: (path: string, handler: ServerPluginRouteHandler) => void
      }
      public: {
        get: (path: string, handler: ServerPluginRouteHandler) => void
        post: (path: string, handler: ServerPluginRouteHandler) => void
        patch: (path: string, handler: ServerPluginRouteHandler) => void
        delete: (path: string, handler: ServerPluginRouteHandler) => void
      }
    }
    loops: {
      /**
       * Register a loop entity source. Source ID must be `<pluginId>.<name>`.
       * The host enforces the namespace lock at registration time.
       */
      registerSource: (source: LoopEntitySource) => void
    }
    /**
     * Read / replace the plugin's persisted settings. The schema declared
     * via `definePlugin({ settings: [...] })` is the source of truth; the
     * host populates defaults at install time and validates updates at the
     * boundary. Emits the `settings.changed` event when values change.
     */
    settings: ServerPluginSettingsApi
    storage: {
      collection: (resourceId: string) => {
        list: (options?: StorageListOptions) => Promise<StorageListResult>
        create: (data: Record<string, unknown>) => Promise<PluginRecord>
        update: (recordId: string, data: Record<string, unknown>) => Promise<PluginRecord | null>
        delete: (recordId: string) => Promise<boolean>
      }
    }
    hooks: ServerPluginHooksApi
    /**
     * Register handlers that fire on a cadence. Requires the
     * `cms.schedule` permission. Handlers run inside the same QuickJS
     * sandbox as the rest of the plugin's server code, with a per-fire
     * wall-clock budget (default 5_000ms, configurable per schedule).
     * The host's scheduler tick (`server/plugins/scheduler.ts`) drives
     * dispatch and persists last-run state across restarts.
     */
    schedule: ServerPluginScheduleApi
    /**
     * Read and write CMS content — entries (rows) and their parent tables.
     *
     * Per-table CRUD shape mirrors `api.cms.storage.collection(id)`:
     *
     *   const pages = api.cms.content.table('pages')
     *   await pages.list({ status: 'published' })
     *   await pages.update(id, { cells: { seo: { title: '…' } } })
     *
     * Schema introspection lives in `content.tables`; tree mutations on
     * `pageTree`-typed fields go through `content.tree(entryId, fieldId)`
     * — the host dispatches each operation through the same engine
     * (`applyTreeOperation`) the visual editor uses. Cross-table
     * helpers (`search`, `getPublishedSnapshot`, `republishAll`) round
     * out the surface.
     *
     * Each method asserts both the granted permission (`cms.content.*`)
     * AND the table allowlist entry in the manifest's `contentAccess[]`.
     * Plugins fail closed on either gap.
     */
    content: {
      tables: {
        list: () => Promise<ReadonlyArray<ContentTableSummary>>
        get: (slug: string) => Promise<ContentTableSchema | null>
        create: (input: CreateContentTableInput) => Promise<ContentTableSchema>
      }
      table: (slug: string) => {
        list: (options?: ContentListOptions) => Promise<ContentListResult>
        get: (entryId: string) => Promise<ContentEntry | null>
        getBySlug: (slug: string) => Promise<ContentEntry | null>
        create: (input: CreateContentEntryInput) => Promise<ContentEntry>
        update: (entryId: string, patch: UpdateContentEntryInput) => Promise<ContentEntry>
        delete: (entryId: string) => Promise<void>
        publish: (entryId: string, options?: { scheduledFor?: string }) => Promise<ContentEntry>
        moveToTable: (entryId: string, targetTableSlug: string) => Promise<ContentEntry>
        createMany: (
          inputs: ReadonlyArray<CreateContentEntryInput>,
        ) => Promise<ReadonlyArray<ContentEntry>>
        updateMany: (
          updates: ReadonlyArray<{ id: string; patch: UpdateContentEntryInput }>,
        ) => Promise<ReadonlyArray<ContentEntry>>
        deleteMany: (entryIds: ReadonlyArray<string>) => Promise<{ deleted: number }>
      }
      tree: (entryId: string, fieldId: string) => {
        read: () => Promise<unknown>
        mutate: (operations: ReadonlyArray<ContentTreeOperation>) => Promise<TreeMutateResult>
        replace: (tree: unknown) => Promise<void>
      }
      search: (query: string, limit?: number) => Promise<ReadonlyArray<ContentSearchResult>>
      getPublishedSnapshot: (entryId: string) => Promise<PublishedSnapshot | null>
      republishAll: () => Promise<{ count: number }>
    }
    /**
     * Media subsystem extension points. Three independent tiers:
     *
     *   • registerStorageAdapter   — handle WRITE/DELETE bytes (S3, R2, …).
     *                                Two-phase: adapter signs upload plan,
     *                                host streams bytes itself.
     *   • registerUrlTransformer   — pure URL rewriter (passive CDN).
     *   • registerVariantDelegate  — replace local variant ladder with
     *                                a URL template (image-transform CDN).
     *
     * Each call requires its own permission — see PLUGIN_PERMISSION_VALUES.
     */
    media: ServerPluginMediaApi
  }
}

// ---------------------------------------------------------------------------
// ServerPluginModule — lifecycle hooks the entrypoint default-exports
// ---------------------------------------------------------------------------

export interface ServerPluginModule {
  install?: (api: ServerPluginApi) => void | Promise<void>
  activate?: (api: ServerPluginApi) => void | Promise<void>
  deactivate?: (api: ServerPluginApi) => void | Promise<void>
  uninstall?: (api: ServerPluginApi) => void | Promise<void>
  /**
   * Called during an upgrade install — between the old version's
   * `deactivate` and the new version's `activate`. Receives the previous
   * version string in `ctx.fromVersion` and the new version's `ServerPluginApi`.
   * If the hook throws, the host rolls back to the previous version's assets.
   * Plugins SHOULD make migrations idempotent.
   */
  migrate?: (ctx: PluginMigrationContext, api: ServerPluginApi) => void | Promise<void>
}
