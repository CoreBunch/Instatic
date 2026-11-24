/**
 * Media storage admin endpoints.
 *
 *   GET    /admin/api/cms/media/storage              — list installed adapters,
 *                                                       installed variant delegates,
 *                                                       current per-role elections,
 *                                                       and current variant-delegate
 *                                                       election.
 *   POST   /admin/api/cms/media/storage/elect        — elect an adapter for a role
 *                                                       (body: { role, adapterId })
 *   POST   /admin/api/cms/media/storage/delegate     — elect a variant delegate
 *                                                       (body: { delegateId })
 *                                                       OR clear it (body: { delegateId: null })
 *   POST   /admin/api/cms/media/storage/verify/:id   — run the adapter's verify()
 *                                                       and return its diagnosis
 *
 * All endpoints are gated by the `storage.elect` capability (formerly
 * `runtime.manage`, now split out — see B3 in the capabilities review).
 * Electing an adapter changes which backend receives every future write
 * for that role; that's a high-trust admin op distinct from "edit the
 * site's package.json".
 *
 * Election is per-role. Reads always dispatch via the row's pinned
 * adapter id, so an election change doesn't strand existing assets —
 * see `server/repositories/mediaStorageAdapters.ts`.
 */

import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  readValidatedBody,
} from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import { CMS_API_PREFIX, type CmsHandlerOptions } from './shared'
import type { MediaAssetRole } from '@core/plugin-sdk'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { mediaVariantDelegateRegistry } from '@core/plugins/mediaVariantDelegateRegistry'
import {
  clearVariantDelegate,
  countAssetsForAdapter,
  electAdapter,
  electVariantDelegate,
  getElectedAdapterId,
  getElectedVariantDelegate,
  listElectedAdapters,
} from '../../repositories/mediaStorageAdapters'
import { countMigrationBacklog } from '../../repositories/mediaMigration'
import { handleMediaStorageMigrate } from './mediaStorageMigration'

const STORAGE_PREFIX = `${CMS_API_PREFIX}/media/storage`
const ALL_ROLES: ReadonlyArray<MediaAssetRole> = [
  'original',
  'variant',
  'avatar',
  'font',
  'plugin-pack',
]


async function handleListStorage(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'storage.elect')
  if (user instanceof Response) return user

  const installedAdapters = mediaStorageRegistry.list()
  const electedAdapters = await listElectedAdapters(db)

  // Hydrate each elected row with the live adapter (when registered) so
  // the admin UI can show "currently elected: <label>" + a warning when
  // an elected adapter is no longer installed.
  const elections = await Promise.all(
    electedAdapters.map(async (election) => ({
      role: election.role,
      adapterId: election.adapterId,
      electedAt: election.electedAt,
      electedByUserId: election.electedByUserId,
      installed: mediaStorageRegistry.resolveForRead(election.adapterId) !== null
        || election.adapterId === '',
      assetCount: await countAssetsForAdapter(db, election.adapterId),
    })),
  )

  const installedDelegates = mediaVariantDelegateRegistry.list()
  const electedDelegate = await getElectedVariantDelegate(db)

  // Per-role migration backlog — the count of rows / variants whose
  // storage_adapter_id doesn't match the elected target. Powers the
  // "Migrate N pending →" affordance in the admin panel. Empty
  // adapter id ('') means local-disk is elected, which is a valid
  // target.
  const originalsTarget = await getElectedAdapterId(db, 'original')
  const variantsTarget = await getElectedAdapterId(db, 'variant')
  const backlog = await countMigrationBacklog(db, {
    original: originalsTarget,
    variant: variantsTarget,
  })

  return jsonResponse({
    roles: ALL_ROLES,
    adapters: installedAdapters.map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
      roles: adapter.roles,
      servingMode: adapter.servingMode,
      isBuiltIn: adapter.id === '',
      cspOrigins: adapter.cspOrigins ?? [],
    })),
    elections,
    delegates: installedDelegates.map((delegate) => ({
      id: delegate.id,
      pluginId: delegate.pluginId,
      variantUrlTemplate: delegate.variantUrlTemplate,
      widths: delegate.widths,
      formats: delegate.formats,
    })),
    electedDelegate,
    migrationBacklog: {
      original: backlog.originals,
      variant: backlog.variants,
    },
  })
}

export const ElectAdapterBodySchema = Type.Object({
  role: Type.Union([
    Type.Literal('original'),
    Type.Literal('variant'),
    Type.Literal('avatar'),
    Type.Literal('font'),
    Type.Literal('plugin-pack'),
  ]),
  adapterId: Type.String(),
})

async function handleElectAdapter(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'storage.elect')
  if (user instanceof Response) return user

  const body = await readValidatedBody(req, ElectAdapterBodySchema)
  if (!body) {
    return badRequest('Invalid `role` — must be one of: ' + ALL_ROLES.join(', '))
  }
  const { role, adapterId: adapterIdRaw } = body
  // Reject elections that point at an adapter id we have no record of.
  // The empty string (local-disk) is always allowed.
  if (adapterIdRaw !== '') {
    const adapter = mediaStorageRegistry.resolveForRead(adapterIdRaw)
    if (!adapter) {
      return jsonResponse(
        { error: `No installed adapter with id "${adapterIdRaw}". Install the plugin first.` },
        { status: 404 },
      )
    }
    if (!adapter.roles.includes(role)) {
      return badRequest(
        `Adapter "${adapterIdRaw}" does not claim the "${role}" role (it claims: ${adapter.roles.join(', ')}).`,
      )
    }
  }
  const election = await electAdapter(db, role, adapterIdRaw, user.id)
  return jsonResponse({ election })
}

export const ElectDelegateBodySchema = Type.Object({
  delegateId: Type.Union([Type.String(), Type.Null()]),
})

async function handleElectDelegate(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'storage.elect')
  if (user instanceof Response) return user

  const body = await readValidatedBody(req, ElectDelegateBodySchema)
  if (!body) {
    return badRequest('Invalid `delegateId` — must be a non-empty string, or null to clear')
  }
  const { delegateId } = body
  if (delegateId === null) {
    await clearVariantDelegate(db)
    return jsonResponse({ electedDelegate: null })
  }
  if (!delegateId) {
    return badRequest('Invalid `delegateId` — must be a non-empty string, or null to clear')
  }
  const delegate = mediaVariantDelegateRegistry.get(delegateId)
  if (!delegate) {
    return jsonResponse(
      { error: `No installed variant delegate with id "${delegateId}". Install the plugin first.` },
      { status: 404 },
    )
  }
  const electedDelegate = await electVariantDelegate(
    db,
    {
      delegateId: delegate.id,
      variantUrlTemplate: delegate.variantUrlTemplate,
      widths: [...delegate.widths],
      formats: delegate.formats,
    },
    user.id,
  )
  return jsonResponse({ electedDelegate })
}

async function handleVerifyAdapter(
  req: Request,
  db: DbClient,
  adapterId: string,
): Promise<Response> {
  const user = await requireCapability(req, db, 'storage.elect')
  if (user instanceof Response) return user

  const adapter = mediaStorageRegistry.resolveForRead(adapterId)
  if (!adapter) {
    return jsonResponse(
      { error: `No installed adapter with id "${adapterId}".` },
      { status: 404 },
    )
  }
  // Defensive — `verify()` is plugin code; any throw becomes a structured
  // failure so the admin UI doesn't crash on a misbehaving adapter.
  try {
    const result = await adapter.verify()
    return jsonResponse({ result })
  } catch (err) {
    const reason = getErrorMessage(err, String(err))
    return jsonResponse({ result: { ok: false, reason } })
  }
}

export async function handleMediaStorageAdminRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
): Promise<Response | null> {
  const { pathname } = new URL(req.url)
  if (!pathname.startsWith(STORAGE_PREFIX)) return null

  if (pathname === STORAGE_PREFIX) {
    if (req.method === 'GET') return handleListStorage(req, db)
    return methodNotAllowed()
  }
  if (pathname === `${STORAGE_PREFIX}/elect`) {
    if (req.method === 'POST') return handleElectAdapter(req, db)
    return methodNotAllowed()
  }
  if (pathname === `${STORAGE_PREFIX}/delegate`) {
    if (req.method === 'POST') return handleElectDelegate(req, db)
    return methodNotAllowed()
  }
  if (pathname === `${STORAGE_PREFIX}/migrate`) {
    // SSE stream — the handler owns its own response lifecycle.
    return handleMediaStorageMigrate(req, db, options.uploadsDir)
  }
  const verifyMatch = pathname.match(new RegExp(`^${STORAGE_PREFIX}/verify/(.+)$`))
  if (verifyMatch) {
    if (req.method === 'POST') {
      return handleVerifyAdapter(req, db, decodeURIComponent(verifyMatch[1] ?? ''))
    }
    return methodNotAllowed()
  }
  return null
}
