/**
 * Two-phase upload dispatcher.
 *
 * Glues the elected `MediaStorageAdapter` together with the host-side
 * executor (`mediaUploadExecutor.ts`). The adapter signs an upload plan
 * inside the QuickJS sandbox; the host streams the bytes here. Bytes
 * NEVER cross the sandbox boundary — that's the core invariant.
 *
 * Flow:
 *
 *   1. `getElectedAdapterId(db, role)`     — snapshot the elected adapter id.
 *   2. `mediaStorageRegistry.resolve(...)` — look up the live adapter.
 *   3. `adapter.beginWrite({ bytes-meta })` — adapter returns an upload plan.
 *   4. `executeUploadPlan(plan, bytes)`    — host streams bytes per step.
 *   5. `adapter.finalizeWrite({ receipts })` — adapter commits + returns URL.
 *
 * On any failure in steps 3..5, `adapter.abortWrite({ storagePath })` is
 * called so the backend doesn't accumulate half-written objects.
 *
 * The dispatcher returns the data the repository needs to insert / update
 * a `media_assets` row (`storagePath`, `publicUrl`, the adapter id pinned
 * on the row, `externallyHosted`). It does NOT touch the DB itself — that's
 * the caller's job, so transactional handling stays at the handler level.
 */

import { nanoid } from 'nanoid'
import type { DbClient } from '../../db/client'
import type {
  MediaAssetRole,
  MediaStorageAdapter,
  MediaStorageWriteResult,
} from '@core/plugin-sdk'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { getElectedAdapterId } from '../../repositories/mediaStorageAdapters'
import { executeUploadPlan, type StepReceipt } from './mediaUploadExecutor'

export class MediaStorageDispatchError extends Error {
  readonly status: number
  readonly adapterId: string
  readonly role: MediaAssetRole
  constructor(message: string, status: number, adapterId: string, role: MediaAssetRole) {
    super(message)
    this.name = 'MediaStorageDispatchError'
    this.status = status
    this.adapterId = adapterId
    this.role = role
  }
}

interface DispatchUploadInput {
  /** Validated bytes (post-magic-byte sniff). */
  bytes: Uint8Array
  /** Server-validated MIME. */
  mimeType: string
  /** Server-chosen safe filename with trusted extension. */
  suggestedStoragePath: string
  role: MediaAssetRole
  /** When `role === 'variant'`, the storagePath of the parent original. */
  variantOf?: string
}

interface DispatchUploadResult {
  /** Persist on `media_assets.storage_path`. */
  storagePath: string
  /** Persist on `media_assets.public_path` — what the renderer emits. */
  publicUrl: string
  /** Persist on `media_assets.storage_adapter_id`. */
  storageAdapterId: string
  /** Persist on `media_assets.externally_hosted`. */
  externallyHosted: boolean
}

/**
 * Compute SHA-256 over the upload bytes. The adapter receives this in
 * `beginWrite` so it can dedupe or verify on the backend side.
 *
 * Web Crypto runs in Bun without an import; the result is a lowercase
 * hex string to match what S3 / R2 etc. expect in their X-Amz-Content-Sha256
 * headers (adapters can use it as-is).
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `Uint8Array` is structurally a valid `BufferSource` but TS's lib.dom
  // currently types `crypto.subtle.digest` as requiring `BufferSource`
  // narrowed to `ArrayBufferView<ArrayBuffer>`. A defensive copy into a
  // tight ArrayBuffer slice satisfies both shapes and avoids accidentally
  // hashing past the end of a sub-array view.
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer)
  const view = new Uint8Array(digest)
  let out = ''
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0')
  }
  return out
}

/**
 * Resolve the adapter the host should write through, given a role. Throws
 * `MediaStorageDispatchError` (503) when the elected adapter id is unknown
 * — that happens when a plugin's adapter was elected and then the plugin
 * was disabled. Falling back to local-disk in that case would silently
 * break the user's "S3 is my primary storage" expectation.
 */
async function resolveWriteAdapter(
  db: DbClient,
  role: MediaAssetRole,
): Promise<MediaStorageAdapter> {
  const adapterId = await getElectedAdapterId(db, role)
  const adapter = mediaStorageRegistry.resolve(adapterId, role)
  if (!adapter) {
    throw new MediaStorageDispatchError(
      adapterId
        ? `Elected media storage adapter "${adapterId}" is not currently available for role "${role}". The plugin that provides it may be disabled.`
        : `No media storage adapter available for role "${role}".`,
      503,
      adapterId,
      role,
    )
  }
  return adapter
}

/**
 * Run the full two-phase upload. The caller passes validated bytes; this
 * function returns the row-shaped result. On any backend failure, the
 * adapter's `abortWrite` is best-effort invoked before the error bubbles.
 */
export async function dispatchUpload(
  db: DbClient,
  input: DispatchUploadInput,
): Promise<DispatchUploadResult> {
  const adapter = await resolveWriteAdapter(db, input.role)
  const contentHash = await sha256Hex(input.bytes)

  // Stage 1 — adapter signs the upload plan.
  const plan = await adapter.beginWrite({
    mimeType: input.mimeType,
    suggestedStoragePath: input.suggestedStoragePath,
    contentHash,
    sizeBytes: input.bytes.byteLength,
    role: input.role,
    ...(input.variantOf ? { variantOf: input.variantOf } : {}),
  })

  // Stage 2 — host streams bytes. On failure, ask the adapter to clean up.
  let receipts: StepReceipt[]
  try {
    receipts = await executeUploadPlan(plan, input.bytes)
  } catch (err) {
    await adapter.abortWrite({ storagePath: plan.storagePath }).catch((abortErr) => {
      console.error(
        `[mediaUploadDispatch] abortWrite failed for "${adapter.id}":`,
        abortErr,
      )
    })
    throw err
  }

  // Stage 3 — adapter commits. A failure here MUST also be aborted because
  // bytes have already landed; the adapter knows how to delete them.
  let result: MediaStorageWriteResult
  try {
    result = await adapter.finalizeWrite({
      storagePath: plan.storagePath,
      uploadReceipts: receipts,
    })
  } catch (err) {
    await adapter.abortWrite({ storagePath: plan.storagePath }).catch((abortErr) => {
      console.error(
        `[mediaUploadDispatch] abortWrite failed for "${adapter.id}":`,
        abortErr,
      )
    })
    throw err
  }

  // For `'public-url'` adapters the renderer emits the absolute URL the
  // plugin returned. For `'signed-redirect'` (and the future `'proxy'`) we
  // own the URL ourselves — the renderer emits `/_instatic/media/<id>/<path>`,
  // browsers hit our router (`tryServeMediaRedirect`), and we ask the
  // adapter for a freshly-signed URL on every request. Substituting the
  // URL here (not in the plugin) keeps signing latency off the page render
  // critical path AND prevents stale signed URLs from being stored on
  // disk in `media_assets.public_path`.
  const publicUrl = adapter.servingMode === 'public-url'
    ? result.publicUrl
    : buildSignedRedirectUrl(adapter.id, plan.storagePath)
  return {
    storagePath: plan.storagePath,
    publicUrl,
    storageAdapterId: adapter.id,
    // `'public-url'` adapters live OUTSIDE the host's uploads dir; the
    // hard-delete path will route through `adapter.delete()` for these.
    externallyHosted: adapter.servingMode === 'public-url' && adapter.id !== '',
  }
}

/**
 * Build the host-owned redirect URL for an adapter that wants to mint
 * signed URLs at read time (`'signed-redirect'`). The shape mirrors the
 * other `/_instatic/*` namespaces; the router's `tryServeMediaRedirect` does
 * the actual lookup + signing.
 *
 * Both segments are URI-encoded so storage paths containing slashes or
 * special chars round-trip cleanly. The router decodes the SAME way.
 */
function buildSignedRedirectUrl(adapterId: string, storagePath: string): string {
  return `/_instatic/media/${encodeURIComponent(adapterId)}/${encodeURIComponent(storagePath)}`
}

/**
 * Best-effort delete against the adapter that wrote the row. The asset
 * row's `storage_adapter_id` is the source of truth — NOT the
 * currently-elected adapter — so reads (and deletes) stay consistent
 * across election swaps.
 *
 * Returns `false` when the adapter is no longer registered (plugin
 * disabled). The caller decides whether to surface that as a 5xx or
 * accept the orphaned bytes.
 */
export async function dispatchDelete(
  storageAdapterId: string,
  storagePath: string,
): Promise<boolean> {
  const adapter = mediaStorageRegistry.resolveForRead(storageAdapterId)
  if (!adapter) {
    console.warn(
      `[mediaUploadDispatch] dispatchDelete: adapter "${storageAdapterId}" not registered — bytes for "${storagePath}" may be orphaned`,
    )
    return false
  }
  await adapter.delete(storagePath)
  return true
}

/**
 * Utility — generate the `nanoid + safeStem + serverExtension` storage
 * path used today by `mediaUpload.ts`. Centralised here so the dispatch
 * layer (which is the only sane place to know the path generation rule)
 * owns it.
 */
export function buildSuggestedStoragePath(safeStem: string, extension: string): string {
  return `${nanoid()}-${safeStem}${extension}`
}
