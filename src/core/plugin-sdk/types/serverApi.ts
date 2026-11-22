import type {
  PluginRecord,
  StorageCreateIfAbsentResult,
  StorageListOptions,
  StorageListResult,
  StorageWriteOptions,
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
import type { ServerPluginMailApi, ServerPluginSiteApi } from './mail'
import type { MemberRouteOptions, ServerPluginMembersApi } from './members'
import type { ServerPluginRouteHandler } from './routes'
import type { ServerPluginScheduleApi } from './schedule'
import type { ServerPluginSettingsApi } from './settings'

// ---------------------------------------------------------------------------
// ServerPluginApi — full API surface available to server entrypoints
// ---------------------------------------------------------------------------

/** `member.get(path, handler)` or `member.get(path, { tag }, handler)`. */
interface MemberRouteRegistrar {
  (path: string, handler: ServerPluginRouteHandler): void
  (path: string, options: MemberRouteOptions, handler: ServerPluginRouteHandler): void
}

/** What `api.cms.rateLimit.take` answers. */
export interface PluginRateLimitResult {
  ok: boolean
  /** Takes left in the window after this one (0 when refused). */
  remaining: number
  /** When refused, ms until a take for this key would be allowed; 0 otherwise. */
  retryAfterMs: number
  /**
   * `limit`: refused, the key used up its limit. `capacity`: allowed, but the
   * plugin's counters were full and forgot their least recently used key.
   * Absent otherwise.
   */
  reason?: 'limit' | 'capacity'
}

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
      /**
       * Routes only a signed-in site member reaches (optionally one holding
       * `tag`). The handler's `ctx.member` is always set. Requires
       * `members.read`. Served on the public plugin mount,
       * `/_instatic/plugins/<pluginId>/<path>`, not under `/admin`.
       */
      member: {
        get: MemberRouteRegistrar
        post: MemberRouteRegistrar
        patch: MemberRouteRegistrar
        delete: MemberRouteRegistrar
      }
    }
    /** Site members: look up, invite, and grant or withdraw access tags. */
    members: ServerPluginMembersApi
    /** Email: send one of the plugin's declared templates through the site's mail queue. */
    mail: ServerPluginMailApi
    /** Facts about the site a plugin needs to build links. No permission needed. */
    site: ServerPluginSiteApi
    /**
     * Sliding-window counters for the plugin's own keys: a throttle, not a
     * lockout. `take` records one use of `key` and says whether it fits:
     * about `limit` uses in any `windowMs` (a two-bucket sliding-window
     * counter: at most `2 × limit − 1` in any true window, and it can refuse
     * for up to `windowMs ÷ limit` while the true count is low). A refused
     * take is not counted. In memory only: a plugin reload, a worker respawn
     * or a server restart drops every counter, and about 10,000 fresh keys in
     * one pair push any counter out, so a defence that must hold belongs in
     * the plugin's own records. `limit` is 1 to 10,000; `windowMs` is one
     * second to one day; at most 16 different pairs (a 17th throws). Each
     * pair holds 10,000 keys; a new key in a full pair forgets the least
     * recently used counter that still has room, and a used-up one only when
     * none has (`reason: 'capacity'`), an order, not a guarantee. Key by
     * `ctx.ipKey`, an account or an API key, never by a value the caller
     * types alone. No permission needed.
     */
    rateLimit: {
      take: (key: string, limit: number, windowMs: number) => Promise<PluginRateLimitResult>
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
     * boundary. A save emits `settings.changed` to this plugin only.
     */
    settings: ServerPluginSettingsApi
    storage: {
      collection: (resourceId: string) => {
        list: (options?: StorageListOptions) => Promise<StorageListResult>
        /**
         * Create a record. Rejects with a `storage_duplicate:` message when
         * the resource has a `uniqueField` and another record holds the value.
         */
        create: (data: Record<string, unknown>) => Promise<PluginRecord>
        /**
         * Create the record, or return the one that already holds its unique
         * key. Atomic across handlers and server instances: of any number of
         * concurrent calls with one key, exactly one gets `created: true`.
         * Needs a `uniqueField` on the resource and a value for it.
         */
        createIfAbsent: (data: Record<string, unknown>) => Promise<StorageCreateIfAbsentResult>
        get: (recordId: string) => Promise<PluginRecord | null>
        /** Look a record up by the value of the resource's `uniqueField`. */
        getByKey: (key: string) => Promise<PluginRecord | null>
        /**
         * Replace a record's data; its `version` goes up by one. With
         * `ifVersion` the write applies only if the record is still at that
         * version, otherwise it rejects with a `storage_conflict:` message.
         * Resolves null when the record does not exist.
         */
        update: (
          recordId: string,
          data: Record<string, unknown>,
          options?: StorageWriteOptions,
        ) => Promise<PluginRecord | null>
        delete: (recordId: string, options?: StorageWriteOptions) => Promise<boolean>
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
     *   await pages.update(id, { cells: { seoTitle: '…' } })
     *
     * Schema introspection lives in `content.tables`; tree mutations on
     * `pageTree`-typed fields go through `content.tree(entryId, fieldId)`
     * — the host dispatches each operation through the same engine
     * (`applyTreeOperation`) the visual editor uses. Cross-table
     * helpers (`search`, `getPublishedSnapshot`, `republishAll`) round
     * out the surface.
     *
     * Each method asserts both the granted permission (`cms.content.*`)
     * AND the table allowlist entry in the manifest's `contentAccess[]` —
     * a slug entry, or the `@own-created` marker for tables this plugin
     * created via `tables.create`. Plugins fail closed on either gap.
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
     * Host-mediated media ingestion plus three independent extension tiers:
     *
     *   • upsert                   — ingest an allowlisted HTTPS image or a
     *                                contained package asset into managed media.
     *
     *   • registerStorageAdapter   — handle WRITE/DELETE bytes (S3, R2, …).
     *                                Two-phase: adapter signs upload plan,
     *                                host streams bytes itself.
     *   • registerUrlTransformer   — pure URL rewriter (passive CDN).
     *   • registerVariantDelegate  — replace local variant ladder with
     *                                a URL template (image-transform CDN).
     *
     * Each call requires its own permission. A remote upsert also requires
     * `network.outbound` and a matching `networkAllowedHosts` entry.
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
