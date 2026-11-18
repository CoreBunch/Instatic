/**
 * Media subsystem — worker round-trips for storage adapters and URL
 * transformers.
 *
 * Bytes NEVER cross the QuickJS sandbox boundary. The adapter signs upload
 * plans here (single round-trip per stage); the host streams bytes itself
 * via `executeUploadPlan` in `server/handlers/cms/mediaUploadExecutor.ts`.
 * `runMediaAdapterCallInWorker` is a generic dispatcher — every adapter
 * method routes through this one helper, mirroring how routes / hook
 * listeners / hook filters use a single shared worker call.
 */

import { nanoid } from 'nanoid'
import { Value } from '@sinclair/typebox/value'
import type {
  MediaAssetRole,
  MediaStorageAdapter,
  MediaStorageBeginWriteInput,
  MediaStorageFinalizeWriteInput,
  MediaStorageServingMode,
  MediaStorageUploadPlan,
  MediaStorageVerifyResult,
  MediaStorageWriteResult,
} from '@core/plugin-sdk'
import { MediaStorageUploadPlanSchema } from '@core/plugin-sdk'
import { requestFromWorker } from './workerPool'
import { describeWorkerError, workerCallError } from './workerErrors'

async function runMediaAdapterCallInWorker(
  pluginId: string,
  adapterId: string,
  method: 'beginWrite' | 'finalizeWrite' | 'abortWrite' | 'delete' | 'getReadUrl' | 'verify',
  args: unknown[],
): Promise<unknown> {
  const result = await requestFromWorker(
    pluginId,
    {
      kind: 'run-media-adapter-call',
      correlationId: nanoid(),
      pluginId,
      adapterId,
      method,
      args,
    },
    'media-adapter-call-result',
  )
  if (!result.ok) {
    throw workerCallError(
      result.error ?? `Plugin "${pluginId}" media adapter "${adapterId}.${method}" failed`,
      result.stack,
    )
  }
  return result.value
}

export async function runMediaUrlTransformerInWorker(
  pluginId: string,
  transformerId: string,
  payload: unknown,
): Promise<string | null> {
  const result = await requestFromWorker(
    pluginId,
    {
      kind: 'run-media-url-transformer',
      correlationId: nanoid(),
      pluginId,
      transformerId,
      payload,
    },
    'media-url-transformer-result',
  )
  if (!result.ok) {
    console.error(
      `[plugin:${pluginId}] media URL transformer threw:`,
      describeWorkerError(result.error, result.stack, 'unknown error'),
    )
    return null
  }
  return typeof result.value === 'string' ? result.value : null
}

function parsePluginUploadPlan(
  value: unknown,
  pluginId: string,
  adapterId: string,
): MediaStorageUploadPlan {
  if (Value.Check(MediaStorageUploadPlanSchema, value)) {
    return value
  }
  throw new Error(
    `Plugin "${pluginId}" adapter "${adapterId}" returned a malformed upload plan`,
  )
}

/**
 * Build a host-side `MediaStorageAdapter` shim that proxies every method
 * to the plugin's VM. The adapter's *contract* (servingMode, roles,
 * cspOrigins, hasGetReadUrl, hasReadStream) is metadata declared at
 * registration time; the actual logic lives inside the QuickJS sandbox
 * and round-trips here for each invocation.
 */
export function buildAdapterShim(args: {
  pluginId: string
  adapterId: string
  label: string
  roles: ReadonlyArray<MediaAssetRole>
  servingMode: MediaStorageServingMode
  hasGetReadUrl: boolean
  hasReadStream: boolean
  cspOrigins?: ReadonlyArray<{ directive: 'img-src' | 'media-src' | 'connect-src'; origin: string }>
}): MediaStorageAdapter {
  const call = (
    method: 'beginWrite' | 'finalizeWrite' | 'abortWrite' | 'delete' | 'getReadUrl' | 'verify',
    methodArgs: unknown[],
  ): Promise<unknown> => runMediaAdapterCallInWorker(args.pluginId, args.adapterId, method, methodArgs)
  const shim: MediaStorageAdapter = {
    id: args.adapterId,
    label: args.label,
    roles: args.roles,
    servingMode: args.servingMode,
    beginWrite: async (input: MediaStorageBeginWriteInput): Promise<MediaStorageUploadPlan> => {
      const v = await call('beginWrite', [input])
      return parsePluginUploadPlan(v, args.pluginId, args.adapterId)
    },
    finalizeWrite: async (input: MediaStorageFinalizeWriteInput): Promise<MediaStorageWriteResult> => {
      const v = await call('finalizeWrite', [input])
      return v as MediaStorageWriteResult
    },
    abortWrite: async (input) => {
      await call('abortWrite', [input])
    },
    delete: async (storagePath: string) => {
      await call('delete', [storagePath])
    },
    verify: async (): Promise<MediaStorageVerifyResult> => {
      const v = await call('verify', [])
      // Defensive: plugin verify() that throws or returns garbage gets
      // converted to a structured failure here so the admin UI doesn't
      // crash on an unexpected shape.
      if (v && typeof v === 'object' && typeof (v as { ok?: unknown }).ok === 'boolean') {
        return v as MediaStorageVerifyResult
      }
      return { ok: false, reason: 'Adapter returned a malformed verify() result.' }
    },
    ...(args.cspOrigins && args.cspOrigins.length > 0 ? { cspOrigins: args.cspOrigins } : {}),
  }
  if (args.hasGetReadUrl) {
    shim.getReadUrl = async (storagePath: string, ttlSeconds: number) => {
      const v = await call('getReadUrl', [storagePath, ttlSeconds])
      if (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') {
        const obj = v as { url: string; expiresAt?: number }
        return {
          url: obj.url,
          expiresAt: typeof obj.expiresAt === 'number' ? obj.expiresAt : Date.now() + ttlSeconds * 1000,
        }
      }
      throw new Error(`Plugin "${args.pluginId}" adapter "${args.adapterId}" returned malformed getReadUrl result`)
    }
  }
  // readStream support for proxy adapters is intentionally not wired in
  // Phase B — proxy-mode adapters land with the host streaming bytes
  // through a separate API (and the QuickJS bridge needs a chunked
  // protocol). Public-URL and signed-redirect adapters are the v1 target.
  return shim
}
