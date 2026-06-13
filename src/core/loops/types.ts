/**
 * Loop entity sources — pluggable data backends for the `base.loop` module.
 *
 * A `LoopEntitySource` describes WHERE a loop pulls items from (content
 * entries, site pages, media assets, plugin-defined collections) and WHAT
 * fields are available for `dynamicBindings` inside the loop's child
 * subtrees. Sources self-register with the singleton in `./registry.ts`,
 * the same pattern used by ModuleRegistry.
 *
 * The shape stays deliberately neutral: each source produces `LoopItem`
 * objects with a generic `fields: Record<string, unknown>` map. The
 * publisher's dynamic-binding resolver reads field values by name; format
 * coercions (e.g. markdown → HTML for body, mediaId → public path for
 * featured media) happen in the source's `fetch()` so the resolver stays
 * a one-line lookup.
 *
 * IDs MUST be namespaced (e.g. `content.entries`, `site.pages`,
 * `acme.products`) so plugins can't shadow built-in sources. Enforced by
 * the registry and by the architecture test
 * `loop-source-id-format.test.ts`.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { PropertySchema } from '@core/module-engine'
import type { SiteDocument } from '@core/page-tree'

// ---------------------------------------------------------------------------
// Field metadata
// ---------------------------------------------------------------------------

/**
 * One field offered by a source. The optional `format` hint travels with
 * the binding so the publisher knows whether to HTML-escape, treat as a
 * URL, or pass-through richtext. See `escapeProps` in the publisher.
 */
export interface LoopSourceField {
  id: string
  label: string
  description?: string
  /**
   * Format hint for downstream rendering:
   *  - 'plain' (default): treat as a string, HTML-escape on emit
   *  - 'html'           : already-rendered HTML, pass through unescaped
   *  - 'url'            : run through `isSafeUrl` before emitting
   *  - 'media'          : URL pointing at a media asset path
   */
  format?: 'plain' | 'html' | 'url' | 'media'
}

// ---------------------------------------------------------------------------
// LoopItem — the unit a loop iterates over
// ---------------------------------------------------------------------------

/**
 * A single item produced by a `LoopEntitySource`. The `fields` map carries
 * resolved values — never IDs that need a second lookup. For example, a
 * `content.entries` LoopItem stores `featuredMediaPath` (the resolved
 * public URL) rather than just `featuredMediaId`.
 *
 * The shape is intentionally generic across source types so that the same
 * publisher / resolver code paths handle every source.
 */
export const LoopItemSchema = Type.Object({
  /** Stable identity — used for keying in the editor and infinite-load dedup. */
  id: Type.String(),
  /** Field values keyed by `LoopSourceField.id`. */
  fields: Type.Record(Type.String(), Type.Unknown()),
})

export type LoopItem = Static<typeof LoopItemSchema>

// ---------------------------------------------------------------------------
// Source contract
// ---------------------------------------------------------------------------

/**
 * Tagged-template SQL surface used by source fetch implementations.
 *
 * Mirrors the essential subset of the server-side `DbClient` (kept in
 * `server/db/client.ts`) so `src/core/loops/` stays free of server-only
 * imports. The publisher passes the real `DbClient` at runtime; it is
 * structurally compatible with this interface.
 *
 * `unsafe` + `dialect` are included so sources can build dialect-aware
 * dynamic SQL (e.g. batched IN-lists) without reaching into the server
 * module tree.
 */
export interface LoopSourceDb {
  <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<{ rows: Row[]; rowCount: number }>
  /**
   * Execute a raw SQL string with positional parameters.
   * Use `dialect` to emit the correct placeholder style:
   *   postgres → $1, $2, …   sqlite → ?, ?, …
   */
  unsafe<Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
  readonly dialect: 'postgres' | 'sqlite'
}

/**
 * Context handed to `LoopEntitySource.fetch()` server-side.
 *
 * `db` is the per-request DB connection — Postgres or SQLite. Sources
 * MUST write only ANSI-standard SQL that works on both engines per the
 * rules in CLAUDE.md.
 */
export interface SourceFetchContext {
  db: LoopSourceDb
  site: SiteDocument
  /** Source-specific filter values, validated against `filterSchema`. */
  filters: Record<string, unknown>
  /** One of the source's `orderByOptions[].id` values. */
  orderBy: string
  direction: 'asc' | 'desc'
  /** Hard cap from the loop instance; sources may further clamp. */
  limit: number
  offset: number
  /**
   * Originating page request context — only populated when the loop is
   * rendered at request time inside a Layer C hole (i.e. the source is
   * `requestDependent` / `perVisitor`). At publish time this is `undefined`
   * and the source must produce publish-time-deterministic output.
   *
   * `cookies` is populated ONLY for `perVisitor` sources (uncacheable holes);
   * for plain `requestDependent` (shared-cache) sources it is an empty object,
   * because cookies would fragment the Layer B cache per visitor.
   */
  request?: SourceRequestContext
}

/**
 * Per-request data delivered to a request-dependent loop source's `fetch()`.
 * Mirrors the publisher's route frame plus parsed cookies, derived from the
 * originating page URL forwarded by the hole runtime.
 */
export interface SourceRequestContext {
  /** Parsed query params of the originating page request (e.g. `?q=shoes`). */
  query: Record<string, string>
  /** Path of the originating page (`/search`), NOT the `/_instatic/hole/…` path. */
  path: string
  /** Trailing path segment, mirrors `RouteFrame.slug`. */
  slug: string | null
  /**
   * Parsed request cookies. Populated ONLY for `perVisitor` sources; empty
   * for shared-cache `requestDependent` sources.
   */
  cookies: Record<string, string>
}

/**
 * Context handed to `LoopEntitySource.preview()` editor-side. No DB
 * available — sources synthesise representative items from the site
 * document or from in-memory state.
 */
interface SourcePreviewContext {
  site: SiteDocument
  filters: Record<string, unknown>
  limit: number
}

export interface LoopFetchResult {
  items: LoopItem[]
  /** Total matching items across all pages. Used for hasMore + paginators. */
  totalItems: number
}

/**
 * Pluggable entity source.
 *
 * Built-in sources live under `src/core/loops/sources/*` and self-register
 * on import. Plugins register additional sources via the plugin SDK
 * (see `src/core/plugin-sdk`).
 */
export interface LoopEntitySource {
  /** Namespaced ID, e.g. `content.entries`, `site.pages`, `acme.products`. */
  id: string
  /** Human label for the source picker. */
  label: string
  description?: string
  /**
   * Whether this source's fetch output varies per visitor request.
   *
   * When `true`, any `base.loop` node using this source is classified as
   * dynamic by `findDynamicNodeIds` and will not receive a
   * pre-rendered disk artefact (Layer A). The loop instead falls through to
   * the Layer B render cache or a Layer C hole.
   *
   * Default (`false` / unset): the source is publish-time-deterministic.
   * Built-in sources (`content.entries`, `site.pages`, `site.media`) all
   * leave this unset — they pull from the CMS database at publish time and
   * bake the result into the static HTML. Plugin sources that hit live
   * external APIs should set this to `true`.
   *
   * A `requestDependent` (but not `perVisitor`) hole is rendered at request
   * time and then CACHED by Layer B keyed on `(nodeId, query, publishVersion)`,
   * so the source's `fetch()` runs once per publish-version per distinct query
   * — not once per visitor. Its `fetch()` receives `ctx.request.query` but an
   * empty `ctx.request.cookies` (cookies would fragment the shared cache).
   */
  requestDependent?: boolean
  /**
   * Whether this source's output varies per individual visitor (cookies,
   * randomisation, wall-clock). Implies `requestDependent` for the purpose
   * of dynamic classification.
   *
   * A `perVisitor` hole BYPASSES the Layer B cache: its `fetch()` runs on
   * EVERY page load and receives the full request context including
   * `ctx.request.cookies`. The response is sent with `Cache-Control: no-store`.
   * Use sparingly — every per-visitor hole is an uncached request-time render.
   */
  perVisitor?: boolean
  /**
   * Property controls rendered in the loop's Properties Panel after the
   * source has been picked. Empty schema = no source-specific filters.
   */
  filterSchema: PropertySchema
  /** Allowed values for the loop's `orderBy` property. */
  orderByOptions: { id: string; label: string }[]
  /** Fields available for `dynamicBindings` inside the loop. */
  fields: LoopSourceField[]
  /** Server-side: produce items + totalItems for the resolved filters/page. */
  fetch(ctx: SourceFetchContext): Promise<LoopFetchResult>
  /** Editor-side: synthesise representative items without DB access. */
  preview(ctx: SourcePreviewContext): LoopItem[]
}

// ---------------------------------------------------------------------------
// Registry interface
// ---------------------------------------------------------------------------

export interface ILoopSourceRegistry {
  register(source: LoopEntitySource): void
  registerOrReplace(source: LoopEntitySource): void
  unregister(id: string): void
  get(id: string): LoopEntitySource | undefined
  getOrThrow(id: string): LoopEntitySource
  has(id: string): boolean
  list(): LoopEntitySource[]
}
