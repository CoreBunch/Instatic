/**
 * Read bytes from a media storage adapter — the inverse of the upload
 * pipeline. Three sources, one helper:
 *
 *   • Built-in local-disk (`storageAdapterId === ''`)
 *     → read the file at `<uploadsDir>/<storagePath>` directly.
 *
 *   • External adapter, `'public-url'` servingMode
 *     → fetch the public URL. The URL is fetchable for as long as the
 *       backend keeps it public-read; the host trusts the adapter's
 *       `finalizeWrite` result here.
 *
 *   • External adapter, `'signed-redirect'` servingMode
 *     → call the adapter's `getReadUrl(storagePath, ttl)` to mint a
 *       short-lived signed URL, then fetch it.
 *
 *   • External adapter, `'proxy'` servingMode
 *     → NOT supported in v1 (the chunked plugin → host stream isn't
 *       wired yet — see Phase B's note on `readStream`). Returns an
 *       explicit error so the migration tool surfaces "this adapter
 *       can't be migrated FROM yet" rather than silently breaking.
 *
 * Bytes flow through Bun's native `fetch` — they never cross the
 * QuickJS sandbox boundary. The adapter only signs URLs on the read
 * side; the host pulls the body itself.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'

interface ReadSourceInput {
  /** Adapter id pinned on the asset row (or `''` for local-disk). */
  storageAdapterId: string
  /** Adapter-internal handle pinned on the asset row. */
  storagePath: string
  /**
   * Public URL pinned on the asset row. Used as the fetch target for
   * `'public-url'` adapters where it's typically a stable absolute URL
   * (e.g. `https://my-bucket.s3.amazonaws.com/...`).
   */
  publicPath: string
  /** Absolute path to the host's uploads directory — required for local-disk. */
  uploadsDir: string
}

class MediaSourceReadError extends Error {
  readonly storageAdapterId: string
  readonly storagePath: string
  constructor(message: string, storageAdapterId: string, storagePath: string) {
    super(message)
    this.name = 'MediaSourceReadError'
    this.storageAdapterId = storageAdapterId
    this.storagePath = storagePath
  }
}

/**
 * Materialize the bytes of an asset. Returns a `Uint8Array` — adequate
 * for v1's per-asset migration loop (which already buffers the upload
 * destination side too).
 *
 * For chunked streaming end-to-end we'd return an `AsyncIterable<Uint8Array>`
 * and thread it through `executeUploadPlan` — out of scope for v1's
 * "move N assets between adapters" tool.
 */
export async function readMediaSourceBytes(input: ReadSourceInput): Promise<Uint8Array> {
  if (input.storageAdapterId === '') {
    // Local disk. The bytes live at `<uploadsDir>/<storagePath>` — same
    // path the static `/uploads/*` handler serves from. We read the file
    // directly rather than going through the static handler because we're
    // already inside the host process; no need to round-trip through HTTP.
    try {
      const buffer = await readFile(join(input.uploadsDir, input.storagePath))
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    } catch (err) {
      throw new MediaSourceReadError(
        `Failed to read local file "${input.storagePath}": ${err instanceof Error ? err.message : String(err)}`,
        input.storageAdapterId,
        input.storagePath,
      )
    }
  }

  // External adapter. Resolve via the registry; the row's pinned adapter
  // id might be stale (plugin disabled / uninstalled) — surface that
  // as a structured error so the migration tool can show it inline.
  const adapter = mediaStorageRegistry.resolveForRead(input.storageAdapterId)
  if (!adapter) {
    throw new MediaSourceReadError(
      `Source adapter "${input.storageAdapterId}" is not currently registered. ` +
        'Re-enable the plugin that provides it before migrating its assets.',
      input.storageAdapterId,
      input.storagePath,
    )
  }

  if (adapter.servingMode === 'proxy') {
    throw new MediaSourceReadError(
      `Source adapter "${input.storageAdapterId}" uses servingMode 'proxy', which the migration tool doesn't support in v1. ` +
        'Migrate FROM a public-url or signed-redirect adapter instead, or wait for the proxy-stream upgrade.',
      input.storageAdapterId,
      input.storagePath,
    )
  }

  // Resolve the fetch URL:
  //   - 'public-url' adapters: the row's publicPath is already the stable
  //     absolute URL (`https://...`).
  //   - 'signed-redirect' adapters: ask the adapter to mint one — short
  //     TTL so a partial migration that resumes much later doesn't trust
  //     stale signatures.
  let fetchUrl: string
  if (adapter.servingMode === 'public-url') {
    fetchUrl = input.publicPath
  } else {
    if (typeof adapter.getReadUrl !== 'function') {
      throw new MediaSourceReadError(
        `Source adapter "${input.storageAdapterId}" is declared 'signed-redirect' but doesn't implement getReadUrl().`,
        input.storageAdapterId,
        input.storagePath,
      )
    }
    const signed = await adapter.getReadUrl(input.storagePath, 60)
    fetchUrl = signed.url
  }

  let response: Response
  try {
    response = await fetch(fetchUrl)
  } catch (err) {
    throw new MediaSourceReadError(
      `fetch("${fetchUrl}") failed: ${err instanceof Error ? err.message : String(err)}`,
      input.storageAdapterId,
      input.storagePath,
    )
  }
  if (!response.ok) {
    throw new MediaSourceReadError(
      `fetch("${fetchUrl}") returned ${response.status}`,
      input.storageAdapterId,
      input.storagePath,
    )
  }
  const buffer = await response.arrayBuffer()
  return new Uint8Array(buffer)
}
