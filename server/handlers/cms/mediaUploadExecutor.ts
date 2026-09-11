/**
 * Host-side upload executor — walks a `MediaStorageUploadPlan` and streams
 * the bytes to each step's URL. The plugin adapter's only job is to
 * produce the plan (signed PUT URLs, headers, ranges). Bytes flow through
 * Bun's native `fetch` here, NEVER through the QuickJS sandbox.
 *
 * Two transport branches:
 *
 *   • `method: 'LOCAL'` (sentinel from `mediaStorageRegistry.LOCAL_DISK_STEP_METHOD`)
 *     → `writeFile` on the local filesystem. The "URL" carries `file://<absolute>`.
 *   • `method: 'PUT' | 'POST'` → `guardedFetch(url, …)`. The step URL is
 *     plugin-controlled, so it goes through the SSRF guard exactly like the
 *     read side (`mediaStorageReader`): internal addresses are refused, the
 *     connection is pinned to the checked IP, and every redirect hop is
 *     re-validated. Without this, `media.storage.adapter` would convey
 *     `network.outbound` reach it never asked for (GHSA-9pq7).
 *     The body is the byte range declared by `step.range` (or the full
 *     buffer when `range` is omitted).
 *
 * On any failure, the caller's two-phase commit is responsible for calling
 * `adapter.abortWrite({ storagePath })` so partial uploads don't pile up.
 * This module raises the error; the caller decides the policy.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MediaStorageUploadPlan } from '@core/plugin-sdk'
import { LOCAL_DISK_STEP_METHOD } from '@core/plugins/mediaStorageRegistry'
import { guardedFetch } from '../../plugins/host/network'
import { toArrayBuffer } from '../../binary'

export interface StepReceipt {
  etag?: string
  versionId?: string
  partNumber?: number
}

/**
 * Execute a single plan step. Returns the receipt the adapter wants in
 * `finalizeWrite`. For local writes the receipt is empty — there's no
 * ETag-equivalent for filesystem writes.
 */
async function executeStep(
  step: MediaStorageUploadPlan['steps'][number],
  bytes: Uint8Array,
  partNumber: number,
): Promise<StepReceipt> {
  // Local-disk sentinel — recognised by string comparison so the SDK type
  // (`'PUT' | 'POST'`) doesn't have to leak the sentinel. The registry's
  // local-disk adapter is the only producer of this method value.
  if ((step.method as string) === LOCAL_DISK_STEP_METHOD) {
    if (!step.url.startsWith('file://')) {
      throw new Error(
        `[mediaUploadExecutor] LOCAL step requires a file:// URL, got "${step.url}"`,
      )
    }
    const absolutePath = step.url.slice('file://'.length)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, bytes)
    return { partNumber }
  }

  // Remote PUT / POST. The host's `fetch` honours `headers` AS-IS — the
  // adapter is trusted to pre-sign and set `Content-Type` correctly.
  // `Content-Length` is added defensively because some signed-URL schemes
  // (S3 PUT, GCS XML PUT) reject requests without it.
  //
  // Body is the underlying ArrayBuffer (not the Uint8Array view) — TS's
  // BodyInit types narrowed `Uint8Array<ArrayBufferLike>` out in
  // lib.dom.d.ts but the runtime accepts both. The buffer slice ensures we
  // send only the declared range, not any sibling view past byteLength.
  const headers: Record<string, string> = {
    'Content-Length': String(bytes.byteLength),
    ...step.headers,
  }
  // Materialise a fresh ArrayBuffer (not SharedArrayBuffer; not a Uint8Array
  // view past byteLength) so the body slot accepts the value without TS
  // narrowing complaints.
  const body = new Uint8Array(toArrayBuffer(bytes))
  // `step.url` comes from a storage-adapter plugin's `beginWrite` plan and is
  // validated for SHAPE only. Route it through the SSRF-safe guard so the
  // write path cannot reach loopback / private / link-local / metadata
  // addresses — the read path's sibling gate (GHSA-rmm7, GHSA-9pq7). No host
  // allowlist: an object-store endpoint is an arbitrary operator-chosen public
  // host, same as the read side.
  const response = await guardedFetch(
    step.url,
    { method: step.method, headers, body },
    { label: 'Media storage upload' },
  )
  if (!response.ok) {
    const text = await response.text().catch(() => '<no body>')
    throw new Error(
      `[mediaUploadExecutor] ${step.method} ${response.status}: ${text.slice(0, 200)}`,
    )
  }
  return {
    etag: response.headers.get('etag') ?? undefined,
    versionId: response.headers.get('x-amz-version-id') ?? undefined,
    partNumber,
  }
}

/**
 * Walk every step in the plan and return the ordered receipts. Steps run
 * sequentially today — when a real cloud adapter needs parallel multipart
 * we'll thread a concurrency limit through here, gated by the plan's
 * upload-budget hint.
 */
export async function executeUploadPlan(
  plan: MediaStorageUploadPlan,
  bytes: Uint8Array,
): Promise<StepReceipt[]> {
  if (plan.expiresAt < Date.now()) {
    throw new Error(
      `[mediaUploadExecutor] Plan for "${plan.storagePath}" expired ${Date.now() - plan.expiresAt}ms ago`,
    )
  }
  const receipts: StepReceipt[] = []
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]
    const slice = step.range
      ? bytes.subarray(step.range.start, step.range.end)
      : bytes
    receipts.push(await executeStep(step, slice, i + 1))
  }
  return receipts
}
