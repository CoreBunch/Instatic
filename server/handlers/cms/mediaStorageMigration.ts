/**
 * Media storage migration tool.
 *
 *   POST /admin/api/cms/media/storage/migrate
 *     body: { role: 'original' | 'variant', toAdapterId: string }
 *     response: text/event-stream
 *
 * Streams progress as the host walks every row / variant pinned to a
 * non-target adapter, transfers the bytes through the existing
 * `dispatchUpload` pipeline, updates the DB row, and (best-effort)
 * deletes the source bytes via `dispatchDelete`.
 *
 * Concurrency control: an in-memory `Map<role, AbortController>` lock
 * prevents two simultaneous migrations of the same role. Cross-process
 * locking isn't necessary today (the CMS runs as a single Bun server);
 * if multi-instance HA ever ships, a DB-level row lock on
 * `active_media_storage_adapter` would replace this Map.
 *
 * Stream shape:
 *   event: started   data: { totalCount, role, toAdapterId }
 *   event: progress  data: { id, ok, migrated, total, error? }
 *   event: done      data: { migrated, failed, total }
 *   event: error     data: { message }
 *
 * Why not a background job table? The migration is interactive — the
 * admin starts it, watches it, can cancel via tab-close. A crash mid-
 * stream leaves some bytes on the destination + the DB still pointing
 * at the source (the per-asset commit order: dest-write → DB update →
 * source-delete is what makes this safe). On retry, already-migrated
 * rows are skipped via the `storage_adapter_id <> target` predicate.
 *
 * v1 scope:
 *   • 'original' — every media_assets row (originals + avatars).
 *     Avatars share the same table; users almost always want them moved
 *     together; lumping them simplifies the picker.
 *   • 'variant'  — variant entries inside variants_json.
 *   • Other roles (font / plugin-pack) return 400 "not supported".
 */

import type { DbClient } from '../../db/client'
import type { MediaAssetRole } from '@core/plugin-sdk'
import { requireCapability } from '../../auth/authz'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { getElectedAdapterId } from '../../repositories/mediaStorageAdapters'
import {
  listAssetsWithPendingVariants,
  listPendingOriginals,
  updateAssetStorageLocation,
  updateVariantStorageLocation,
  type PendingOriginal,
  type PendingVariantContainer,
} from '../../repositories/mediaMigration'
import {
  dispatchDelete,
  dispatchUpload,
  MediaStorageDispatchError,
  buildSuggestedStoragePath,
} from './mediaUploadDispatch'
import { readMediaSourceBytes } from './mediaStorageReader'

// ---------------------------------------------------------------------------
// In-memory per-role lock
// ---------------------------------------------------------------------------

const activeMigrations = new Map<MediaAssetRole, AbortController>()

function tryAcquireLock(role: MediaAssetRole): AbortController | null {
  if (activeMigrations.has(role)) return null
  const controller = new AbortController()
  activeMigrations.set(role, controller)
  return controller
}

function releaseLock(role: MediaAssetRole): void {
  activeMigrations.delete(role)
}

// ---------------------------------------------------------------------------
// SSE encoding
// ---------------------------------------------------------------------------

type ProgressEvent =
  | { kind: 'started'; total: number; role: MediaAssetRole; toAdapterId: string }
  | { kind: 'progress'; id: string; ok: boolean; migrated: number; total: number; error?: string }
  | { kind: 'done'; migrated: number; failed: number; total: number }
  | { kind: 'error'; message: string }

interface Emitter {
  send: (event: ProgressEvent) => void
  close: () => void
}

function makeEmitter(controller: ReadableStreamDefaultController<Uint8Array>): Emitter {
  const encoder = new TextEncoder()
  let closed = false
  return {
    send(event: ProgressEvent) {
      if (closed) return
      try {
        controller.enqueue(encoder.encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`))
      } catch {
        closed = true
      }
    },
    close() {
      if (closed) return
      closed = true
      try { controller.close() } catch { /* already closed */ }
    },
  }
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

const MigrateBodySchema = Type.Object({
  // v1 only supports 'original' and 'variant'; font and plugin-pack are future work.
  role: Type.Union([Type.Literal('original'), Type.Literal('variant')]),
  toAdapterId: Type.String(),
})

export async function handleMediaStorageMigrate(
  req: Request,
  db: DbClient,
  uploadsDir: string | undefined,
): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed()
  // `storage.migrate` is its own capability (split out of the old
  // `runtime.manage`) — the migration SSE moves real bytes between
  // adapters and is a separately-grantable operation from electing an
  // adapter in the first place.
  const user = await requireCapability(req, db, 'storage.migrate')
  if (user instanceof Response) return user
  if (!uploadsDir) {
    return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
  }

  const body = await readValidatedBody(req, MigrateBodySchema)
  if (!body) {
    return badRequest(
      "Invalid request body — expected { role: 'original' | 'variant', toAdapterId: string }.",
    )
  }
  const { role, toAdapterId } = body

  // Reject elections at a different adapter than the request claims.
  // Migration MUST go to the currently-elected adapter for the role —
  // otherwise we'd be moving bytes to a backend new uploads aren't using,
  // which is just a slower way to strand them.
  const electedId = await getElectedAdapterId(db, role)
  if (electedId !== toAdapterId) {
    return badRequest(
      `Target adapter "${toAdapterId}" is not the currently-elected adapter for role "${role}" (elected: "${electedId}"). Elect it first, then migrate.`,
    )
  }

  // The target adapter must be registered (or the empty-string built-in).
  if (toAdapterId !== '' && !mediaStorageRegistry.resolveForRead(toAdapterId)) {
    return jsonResponse(
      { error: `Target adapter "${toAdapterId}" is not currently available.` },
      { status: 503 },
    )
  }

  const lock = tryAcquireLock(role)
  if (!lock) {
    return jsonResponse(
      { error: `A migration of role "${role}" is already in progress. Wait for it to finish.` },
      { status: 409 },
    )
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emitter = makeEmitter(controller)

      // Tear down on client disconnect (tab close / EventSource.close).
      // The current asset finishes cleanly; the loop checks aborted state
      // between assets and short-circuits.
      req.signal.addEventListener('abort', () => {
        lock.abort()
      })

      runMigration({
        db,
        role,
        toAdapterId,
        uploadsDir,
        signal: lock.signal,
        emit: emitter.send,
      })
        .catch((err) => {
          const message = getErrorMessage(err, String(err))
          emitter.send({ kind: 'error', message })
        })
        .finally(() => {
          releaseLock(role)
          emitter.close()
        })
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}

// ---------------------------------------------------------------------------
// Migration loop
// ---------------------------------------------------------------------------

interface RunMigrationArgs {
  db: DbClient
  role: MediaAssetRole
  toAdapterId: string
  uploadsDir: string
  signal: AbortSignal
  emit: (event: ProgressEvent) => void
}

async function runMigration(args: RunMigrationArgs): Promise<void> {
  if (args.role === 'original') {
    await runOriginalMigration(args)
  } else if (args.role === 'variant') {
    await runVariantMigration(args)
  }
}

async function runOriginalMigration(args: RunMigrationArgs): Promise<void> {
  let migrated = 0
  let failed = 0
  let total = 0

  // First pass over all pages to compute the total. We could use the
  // backlog count from `countMigrationBacklog` but the loop's
  // pagination already walks every row exactly once — capturing total
  // upfront so the progress event carries a useful denominator.
  let cursor: string | null = null
  let firstBatch: PendingOriginal[] | null = null
  for (;;) {
    if (args.signal.aborted) break
    const page = await listPendingOriginals(args.db, args.toAdapterId, cursor)
    if (firstBatch === null) firstBatch = page.items
    total += page.items.length
    cursor = page.nextCursor
    if (!cursor) break
  }
  args.emit({ kind: 'started', total, role: 'original', toAdapterId: args.toAdapterId })

  // Second pass — actually do the migration. The cursor walks again
  // because new rows might have been added between the count pass and
  // here; we use a single counter for the progress event.
  cursor = null
  for (;;) {
    if (args.signal.aborted) break
    const page = await listPendingOriginals(args.db, args.toAdapterId, cursor)
    for (const item of page.items) {
      if (args.signal.aborted) break
      try {
        await migrateOneOriginal(args, item)
        migrated += 1
        args.emit({ kind: 'progress', id: item.id, ok: true, migrated, total })
      } catch (err) {
        failed += 1
        const message = getErrorMessage(err, String(err))
        args.emit({ kind: 'progress', id: item.id, ok: false, migrated, total, error: message })
        console.error(`[mediaMigration] original "${item.id}" failed:`, err)
      }
    }
    cursor = page.nextCursor
    if (!cursor) break
  }
  args.emit({ kind: 'done', migrated, failed, total })
}

async function migrateOneOriginal(args: RunMigrationArgs, item: PendingOriginal): Promise<void> {
  // 1. Read source bytes (local fs OR fetch from adapter URL).
  const bytes = await readMediaSourceBytes({
    storageAdapterId: item.storageAdapterId,
    storagePath: item.storagePath,
    publicPath: item.publicPath,
    uploadsDir: args.uploadsDir,
  })

  // 2. Dispatch upload to the target adapter (currently elected for role).
  //    The dispatcher does the two-phase beginWrite / executeUploadPlan /
  //    finalizeWrite dance; if any step fails we bubble before touching
  //    the DB so the row keeps pointing at the source.
  const suggested = buildSuggestedStoragePath('migrated', extensionForMime(item.mimeType))
  const dispatched = await dispatchUpload(args.db, {
    bytes,
    mimeType: item.mimeType,
    suggestedStoragePath: suggested,
    role: 'original',
  })

  // 3. Update the row to point at the new bytes BEFORE deleting the
  //    source. A crash between 3 and 4 leaks bytes on the source side
  //    (harmless; they're orphaned but still readable). A crash before
  //    3 leaves the destination orphaned (next migration pass picks the
  //    row up again because storage_adapter_id is still the source).
  await updateAssetStorageLocation(args.db, item.id, {
    storagePath: dispatched.storagePath,
    publicPath: dispatched.publicUrl,
    storageAdapterId: dispatched.storageAdapterId,
    externallyHosted: dispatched.externallyHosted,
  })

  // 4. Best-effort delete source. A failure here is logged but doesn't
  //    fail the asset — the destination already has the bytes, the row
  //    already points at them, and an orphaned source file can be
  //    swept by a future garbage-collection job.
  await dispatchDelete(item.storageAdapterId, item.storagePath).catch((err) => {
    console.warn(
      `[mediaMigration] source delete failed for "${item.id}" (orphaned bytes on adapter "${item.storageAdapterId}"):`,
      err,
    )
  })
}

async function runVariantMigration(args: RunMigrationArgs): Promise<void> {
  let migrated = 0
  let failed = 0
  let total = 0

  // First pass — total = count of pending variant entries.
  let cursor: string | null = null
  for (;;) {
    if (args.signal.aborted) break
    const page = await listAssetsWithPendingVariants(args.db, args.toAdapterId, cursor)
    for (const container of page.items) {
      for (const v of container.variants) {
        if (v.storageAdapterId !== args.toAdapterId) total += 1
      }
    }
    cursor = page.nextCursor
    if (!cursor) break
  }
  args.emit({ kind: 'started', total, role: 'variant', toAdapterId: args.toAdapterId })

  cursor = null
  for (;;) {
    if (args.signal.aborted) break
    const page = await listAssetsWithPendingVariants(args.db, args.toAdapterId, cursor)
    for (const container of page.items) {
      if (args.signal.aborted) break
      for (const variant of container.variants) {
        if (args.signal.aborted) break
        if (variant.storageAdapterId === args.toAdapterId) continue
        const eventId = `${container.id}:${variant.path}`
        try {
          await migrateOneVariant(args, container, variant)
          migrated += 1
          args.emit({ kind: 'progress', id: eventId, ok: true, migrated, total })
        } catch (err) {
          failed += 1
          const message = getErrorMessage(err, String(err))
          args.emit({ kind: 'progress', id: eventId, ok: false, migrated, total, error: message })
          console.error(`[mediaMigration] variant "${eventId}" failed:`, err)
        }
      }
    }
    cursor = page.nextCursor
    if (!cursor) break
  }
  args.emit({ kind: 'done', migrated, failed, total })
}

async function migrateOneVariant(
  args: RunMigrationArgs,
  container: PendingVariantContainer,
  variant: PendingVariantContainer['variants'][number],
): Promise<void> {
  // Virtual variants from a Tier-3 delegate carry no host-stored bytes —
  // their `storagePath` is `delegate:<id>`. We skip them because:
  //   - there's nothing to download
  //   - there's nothing to upload (they regenerate on the fly at the CDN)
  // The DB record stays untouched; if the delegate is cleared, a
  // re-upload regenerates the local ladder.
  if (variant.storageAdapterId.startsWith('delegate:')) {
    throw new MediaStorageDispatchError(
      'Virtual delegate variants have no host-stored bytes; clear the variant delegate election before migrating.',
      400,
      variant.storageAdapterId,
      'variant',
    )
  }

  const bytes = await readMediaSourceBytes({
    storageAdapterId: variant.storageAdapterId,
    storagePath: variant.storagePath,
    publicPath: variant.path,
    uploadsDir: args.uploadsDir,
  })

  const suggested = buildSuggestedStoragePath(
    `migrated-variant-w${variant.width}`,
    `.${variant.format}`,
  )
  const dispatched = await dispatchUpload(args.db, {
    bytes,
    // Variants are always one of webp / jpeg / png / avif; build the
    // MIME from the format literal so the adapter sees the right one.
    mimeType: `image/${variant.format}`,
    suggestedStoragePath: suggested,
    role: 'variant',
    variantOf: container.parentStoragePath,
  })

  const updated = await updateVariantStorageLocation(args.db, container.id, variant.path, {
    path: dispatched.publicUrl,
    storagePath: dispatched.storagePath,
    storageAdapterId: dispatched.storageAdapterId,
    sizeBytes: variant.sizeBytes,
  })
  if (!updated) {
    // The row got rewritten under us — clean up the destination bytes we
    // just wrote so they don't leak. The next migration run will pick
    // up the row's new shape.
    await dispatchDelete(dispatched.storageAdapterId, dispatched.storagePath).catch(() => {/* noop */})
    throw new Error(
      `Variant row for "${container.id}" changed during migration; this variant will be migrated on the next run.`,
    )
  }
  await dispatchDelete(variant.storageAdapterId, variant.storagePath).catch((err) => {
    console.warn(
      `[mediaMigration] source delete failed for variant on "${container.id}" (orphaned bytes):`,
      err,
    )
  })
}

// ---------------------------------------------------------------------------
// Extension lookup
//
// Migration preserves the existing MIME type. We need to attach a
// trusted extension to the destination's storage_path (so the static
// handler / CDN serves with the right Content-Type). This mirrors the
// mediaUpload.EXTENSION_FOR_MIME table but stays local to the migration
// module so the upload code doesn't have to export it just for us.
// ---------------------------------------------------------------------------

function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return '.jpg'
    case 'image/png': return '.png'
    case 'image/gif': return '.gif'
    case 'image/webp': return '.webp'
    case 'image/avif': return '.avif'
    case 'video/mp4': return '.mp4'
    case 'video/webm': return '.webm'
    default:
      // Unknown MIME (shouldn't happen — uploads are filtered to the
      // whitelist) — fall back to '.bin' so we never produce a
      // dot-less storage_path.
      return '.bin'
  }
}

// Reference the read-error type so we keep its export from
// `mediaStorageReader.ts` linked to this module's call site — useful
// when future cleanup wants to surface source-read errors distinctly
// from upload errors in the UI.

