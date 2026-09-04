// ---------------------------------------------------------------------------
// Media storage adapter — Tier 2 of the media plugin surface.
//
// Adapters register exclusively per role via api.cms.media.registerStorageAdapter
// and are elected by the admin from "Settings → Media storage". The host
// writes ROUND ONE (beginWrite → adapter returns a signed PUT plan), then
// streams the bytes itself, then commits ROUND TWO (finalizeWrite). Bytes
// never cross the QuickJS sandbox boundary.
//
// Independent permissions gate media ingestion and the three extension tiers; see
// PLUGIN_PERMISSION_VALUES for the full mapping.
// ---------------------------------------------------------------------------

import { Type, type Static } from '@sinclair/typebox'

// ---------------------------------------------------------------------------
// Remote media ingestion.
// ---------------------------------------------------------------------------

export const RemoteMediaUpsertInputSchema = Type.Object({
  /** Stable identity from the upstream system, scoped to the calling plugin. */
  sourceKey: Type.String({ minLength: 1, maxLength: 500 }),
  /** Public HTTPS URL the host should download. */
  sourceUrl: Type.String({ minLength: 1, maxLength: 2_048 }),
  /**
   * Upstream revision, ETag, or updated-at value. Reusing the same version
   * returns the existing asset without downloading it again. When omitted,
   * the host downloads and compares the content hash.
   */
  sourceVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  filename: Type.String({ minLength: 1, maxLength: 255 }),
  altText: Type.Optional(Type.String({ maxLength: 4_096 })),
}, { additionalProperties: false })

export type RemoteMediaUpsertInput = Static<typeof RemoteMediaUpsertInputSchema>

export const RemoteMediaAssetSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  filename: Type.String(),
  publicPath: Type.String({ minLength: 1 }),
  mimeType: Type.String({ minLength: 1 }),
  altText: Type.String(),
  width: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  height: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
}, { additionalProperties: false })

export type RemoteMediaAsset = Static<typeof RemoteMediaAssetSchema>

export const RemoteMediaUpsertResultSchema = Type.Object({
  status: Type.Union([
    Type.Literal('created'),
    Type.Literal('unchanged'),
    Type.Literal('replaced'),
  ]),
  asset: RemoteMediaAssetSchema,
}, { additionalProperties: false })

export type RemoteMediaUpsertResult = Static<typeof RemoteMediaUpsertResultSchema>

/**
 * Asset roles the storage subsystem distinguishes. An adapter declares the
 * subset of roles it wants to handle. Different adapters may be elected
 * for different roles (e.g. S3 for `original`, local for `avatar`).
 *
 * `'plugin-pack'` covers plugin-shipped static files (icons, frontend JS,
 * module bundles) extracted under `/uploads/plugins/<id>/<version>/`. It is
 * NOT routable to a storage adapter today — plugin assets remain local for
 * cold-start latency — but is reserved in the enum so the type stays stable
 * if we change that decision later.
 */
export type MediaAssetRole =
  | 'original'
  | 'variant'
  | 'avatar'
  | 'font'
  | 'plugin-pack'

/**
 * How the adapter wants reads served. Picked once at registration; the host
 * wires the read path differently per mode.
 *
 *   • `'public-url'`      — `write()` returned a forever-fetchable URL. Renderers
 *                           emit that URL directly. The host's `/uploads/*`
 *                           handler is bypassed entirely for this asset.
 *   • `'signed-redirect'` — Host issues `getReadUrl()` per request, 302-redirects
 *                           the browser. Required for private buckets or
 *                           hotlink-protected CDNs.
 *   • `'proxy'`           — Host streams the bytes via `readStream()` back to
 *                           the browser. Rare; required only when the backend
 *                           offers neither public URLs nor signed URLs.
 */
export type MediaStorageServingMode = 'public-url' | 'signed-redirect' | 'proxy'

export interface MediaStorageBeginWriteInput {
  /** Server-validated MIME (one of `EXTENSION_FOR_MIME`'s keys). */
  mimeType: string
  /**
   * Server-chosen safe filename WITH the server-trusted extension. The
   * adapter is free to use it as-is, prefix it, hash it, or remap it — the
   * `storagePath` it returns in the plan is what the host stores on the
   * DB row.
   */
  suggestedStoragePath: string
  /** SHA-256 of the bytes (lowercase hex). Adapters can dedupe / verify. */
  contentHash: string
  /** Total bytes the host will stream — adapter knows the exact Content-Length. */
  sizeBytes: number
  role: MediaAssetRole
  /** When `role === 'variant'`, the storagePath of the parent original. */
  variantOf?: string
}

export const MediaStorageUploadStepSchema = Type.Object({
  method: Type.Union([Type.Literal('PUT'), Type.Literal('POST')]),
  url: Type.String({ minLength: 1 }),
  headers: Type.Record(Type.String(), Type.String()),
  range: Type.Optional(Type.Object({
    start: Type.Number(),
    end: Type.Number(),
  }, { additionalProperties: false })),
}, { additionalProperties: false })

/**
 * One step in the upload plan. Most providers need a single PUT — that's
 * one entry. S3 multipart / GCS resumable need multiple steps; the host
 * walks the array in order and POSTs/PUTs each one.
 */
export type MediaStorageUploadStep = Static<typeof MediaStorageUploadStepSchema>

export const MediaStorageUploadPlanSchema = Type.Object({
  storagePath: Type.String({ minLength: 1 }),
  steps: Type.Array(MediaStorageUploadStepSchema),
  expiresAt: Type.Number(),
}, { additionalProperties: false })

/**
 * Adapter upload plan returned from `beginWrite`.
 *
 * `storagePath` is the adapter's final on-storage handle. It is persisted in
 * `media_assets.storage_path` and passed back to `finalizeWrite` / `delete` /
 * `getReadUrl`.
 *
 * `steps` is the ordered list the host executes. `[]` is legal and means
 * "no bytes to upload". The built-in local-disk adapter uses a private
 * host-only sentinel that plugin plans cannot return.
 *
 * `expiresAt` is the plan expiry epoch ms; the host aborts if any step is
 * initiated after this.
 */
export type MediaStorageUploadPlan = Static<typeof MediaStorageUploadPlanSchema>

export interface MediaStorageFinalizeWriteInput {
  storagePath: string
  /** Echoed receipts (ETag, version-id, part number) from each completed step. */
  uploadReceipts: ReadonlyArray<{
    etag?: string
    versionId?: string
    partNumber?: number
  }>
}

export interface MediaStorageWriteResult {
  /**
   * What the renderer / browser emits. May be:
   *   • absolute URL (`https://cdn.example.com/...`) for `'public-url'` adapters
   *   • host-relative path (`/uploads/<storagePath>`) for `'signed-redirect'`
   *     and `'proxy'` adapters — host resolves at request time.
   */
  publicUrl: string
  /** Adapter-specific tags; opaque to host, surfaced in admin debug. */
  metadata?: Record<string, string>
}

export interface MediaStorageVerifyResult {
  ok: boolean
  /** Short prose surfaced inline next to the "Test connection" button. */
  reason?: string
  /** Optional follow-up hint (e.g. "check IAM policy"). */
  hint?: string
}

/**
 * A plugin-registered storage backend (S3, R2, GCS, Azure, …).
 *
 * v1 dispatch ceiling: the QuickJS host invokes each method below with AT MOST
 * 2 positional arguments — `__runMediaAdapterCall` in
 * `server/plugins/quickjs/bootstrap/src/pluginRuntime.ts` spreads
 * `args[0], args[1]` only. Every method here fits that today (`getReadUrl`
 * takes the most, at 2). A future method needing a 3rd argument MUST widen that
 * runner in the same change, or the 3rd arg will silently arrive as
 * `undefined` inside the VM. Prefer a single options object over a 3rd param.
 */
export interface MediaStorageAdapter {
  /**
   * Adapter id — MUST be `<pluginId>.<rest>`. Surfaced in the admin
   * storage-backend picker.
   */
  id: string
  /** Display name in the admin picker, e.g. "Amazon S3", "Cloudflare R2". */
  label: string
  /**
   * Roles this adapter is willing to handle. Election is per-role: the admin
   * can pick `s3` for originals and `local` for avatars independently. An
   * adapter that omits a role cannot be elected for it.
   */
  roles: ReadonlyArray<MediaAssetRole>
  /** How reads are served — see `MediaStorageServingMode`. */
  servingMode: MediaStorageServingMode
  /**
   * Round one: return a signed upload plan. The host then streams bytes
   * directly to the URLs in the plan using its own runtime fetch — bytes
   * NEVER cross the sandbox boundary.
   *
   * Adapters MUST be idempotent on `suggestedStoragePath` — the host may
   * retry `beginWrite` on transient failures before giving up.
   */
  beginWrite: (input: MediaStorageBeginWriteInput) => Promise<MediaStorageUploadPlan>
  /**
   * Round two: confirm the upload landed. Host calls this AFTER it has
   * received 2xx on every step. Adapter returns the final shape persisted
   * on the DB row.
   */
  finalizeWrite: (input: MediaStorageFinalizeWriteInput) => Promise<MediaStorageWriteResult>
  /**
   * Cleanup. Called when round-one succeeded but round-two (host PUT) failed.
   * Idempotent — adapter MUST swallow "already gone".
   */
  abortWrite: (input: { storagePath: string }) => Promise<void>
  /**
   * Required for `servingMode === 'public-url'`     — return a stable URL.
   * Required for `servingMode === 'signed-redirect'` — return a short-lived URL.
   * MUST be `undefined` for `servingMode === 'proxy'`.
   */
  getReadUrl?: (
    storagePath: string,
    ttlSeconds: number,
  ) => Promise<{ url: string; expiresAt: number }>
  /**
   * Required for `servingMode === 'proxy'` only. Host iterates the async-iter,
   * piping chunks into the response body so the VM heap never holds the
   * whole object. Bytes flow plugin → host as base64-encoded chunks of at
   * most 256 KB each.
   */
  readStream?: (storagePath: string) => AsyncIterable<Uint8Array>
  /** Hard-delete. Idempotent — MUST swallow "already gone". */
  delete: (storagePath: string) => Promise<void>
  /**
   * Pre-flight connectivity check called from the admin "Test connection"
   * button BEFORE election. Returns a structured diagnosis the host renders
   * inline — never throws.
   */
  verify: () => Promise<MediaStorageVerifyResult>
  /**
   * Optional. Declared CSP origins the host should add to `img-src` /
   * `media-src` / `connect-src` in the editor preview iframe and the
   * published-page CSP. Static — declared once at registration.
   */
  cspOrigins?: ReadonlyArray<{
    directive: 'img-src' | 'media-src' | 'connect-src'
    origin: string
  }>
}

// ---------------------------------------------------------------------------
// Media URL transformer — Tier 1.
// ---------------------------------------------------------------------------

export interface MediaUrlTransformContext {
  kind: 'original' | 'variant'
  /** Intrinsic width when `kind === 'variant'`. Absent for originals. */
  width?: number
  /** Variant pixel format. Absent for originals. */
  format?: 'webp' | 'jpeg' | 'png' | 'avif'
  /** MIME type of the original asset (`'image/jpeg'`, `'video/mp4'`, …). */
  originalMimeType: string
}

/**
 * Pure path → path rewriter. Runs at every point the renderer materializes
 * a media URL. Returning `null` means "no change; pass through to the next
 * transformer in the chain".
 */
export type MediaUrlTransformer = (
  path: string,
  ctx: MediaUrlTransformContext,
) => string | null

// ---------------------------------------------------------------------------
// Media variant delegate — Tier 3.
// ---------------------------------------------------------------------------

/**
 * Replaces the host's local image-variant ladder with a URL template. When
 * a plugin registers a delegate and is elected, the host STOPS generating
 * local variants — only the original + BlurHash are stored. Variant URLs
 * are computed on demand by the renderer using the template.
 *
 * Template placeholders the host substitutes:
 *   {path}          → original asset path (e.g. `/uploads/foo.jpg`)
 *   {width}         → variant intrinsic width
 *   {format}        → `'webp'` | `'jpeg'` | `'png'` | `'avif'`
 *   {quality}       → integer 1..100 (defaults to 80)
 *   {originalMime}  → mime type of the original (`image/jpeg`)
 *
 * Example (Cloudflare Images):
 *   `https://example.com/cdn-cgi/image/width={width},format={format},quality=80{path}`
 */
export interface MediaVariantDelegate {
  /** Delegate id — MUST be `<pluginId>.<rest>`. */
  id: string
  /** URL template. Static; declared once at registration. */
  variantUrlTemplate: string
  /** Widths the renderer should emit in `srcset` (replaces the local ladder). */
  widths: ReadonlyArray<number>
  /** Formats emitted; usually `['webp']` or `['avif', 'webp']`. */
  formats: ReadonlyArray<'webp' | 'jpeg' | 'avif'>
}

// ---------------------------------------------------------------------------
// ServerPluginMediaApi — registration surface exposed via api.cms.media
// ---------------------------------------------------------------------------

export interface ServerPluginMediaApi {
  /**
   * Create or update a managed media asset from a remote HTTPS URL. The host
   * downloads and validates the bytes, writes through the elected storage
   * adapter, and runs the normal responsive-image pipeline. Image bytes never
   * cross the QuickJS boundary.
   *
   * `sourceKey` is scoped to this plugin and makes scheduled syncs idempotent.
   * Requires `media.import.remote`, `network.outbound`, and a matching
   * `networkAllowedHosts` entry for every redirect hop.
   */
  upsertRemote: (input: RemoteMediaUpsertInput) => Promise<RemoteMediaUpsertResult>
  /**
   * Register an exclusive storage adapter. The admin elects which adapter
   * handles each role from "Settings → Media storage". An adapter cannot
   * be elected for a role it doesn't declare in `roles`.
   *
   * Requires the `media.storage.adapter` permission. Adapter id MUST be
   * `<pluginId>.<rest>`. Re-registering an adapter with the same id
   * (e.g. on plugin re-activation) replaces the previous definition.
   */
  registerStorageAdapter: (adapter: MediaStorageAdapter) => void
  /**
   * Register a URL transformer. Chained with every other registered
   * transformer (registration order = chain order). Requires the
   * `media.url.transform` permission.
   */
  registerUrlTransformer: (transformer: MediaUrlTransformer) => void
  /**
   * Register a variant delegate. Only one delegate is active per host —
   * the admin picks the winner. Requires the `media.variant.delegate`
   * permission. Delegate id MUST be `<pluginId>.<rest>`.
   */
  registerVariantDelegate: (delegate: MediaVariantDelegate) => void
}
