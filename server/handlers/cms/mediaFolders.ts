/**
 * Media folder endpoints — capabilities mirror the asset endpoints.
 *
 *   GET    /admin/api/cms/media/folders         — flat list; client builds tree
 *                                                  (`media.read` — folder tree
 *                                                  is part of the library view)
 *   POST   /admin/api/cms/media/folders         — { name, parentId? }
 *                                                  (`media.write`)
 *   PATCH  /admin/api/cms/media/folders/:id     — { name?, parentId?, sortOrder? }
 *                                                  (`media.write`)
 *   DELETE /admin/api/cms/media/folders/:id     — cascade removes child folders +
 *                                                  asset membership rows (assets
 *                                                  themselves stay, just become
 *                                                  Uncategorized)
 *                                                  (`media.delete` — destructive,
 *                                                  matches asset delete gate)
 *
 * Slug is auto-generated from the name on create and on rename (when `name`
 * changes). Uniqueness scoped per parent (gated by a unique index on
 * `coalesce(parent_id, '')` + `slug`) so users can have two "Logos" folders
 * under different roots.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import {
  createMediaFolder,
  deleteMediaFolder,
  getMediaFolder,
  isMediaFolderSlugTaken,
  listMediaFolders,
  updateMediaFolder,
  type UpdateMediaFolderInput,
} from '../../repositories/mediaFolders'
import { slugFromTitle } from '@core/utils/slug'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { CMS_API_PREFIX } from './shared'
import { runRouteTable, type Route, type RouteParams } from './routeTable'

const FOLDERS_PATH = `${CMS_API_PREFIX}/media/folders`

// ---------------------------------------------------------------------------
// Per-route handlers
// ---------------------------------------------------------------------------

export const CreateFolderBodySchema = Type.Object({
  name: Type.String(),
  parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

export const PatchFolderBodySchema = Type.Object({
  name: Type.Optional(Type.String()),
  // Three states: undefined = keep existing parent, null = move to root,
  // string = reparent to that folder id.
  parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sortOrder: Type.Optional(Type.Number()),
})

async function handleListFolders(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'media.read')
  if (user instanceof Response) return user
  return jsonResponse({ folders: await listMediaFolders(db) })
}

async function handleCreateFolder(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'media.write')
  if (user instanceof Response) return user

  const body = await readValidatedBody(req, CreateFolderBodySchema)
  if (!body) return badRequest('Invalid request body')
  const name = body.name.trim()
  if (!name) return badRequest('Folder name is required')
  const parentId = body.parentId ?? null

  if (parentId !== null) {
    const parent = await getMediaFolder(db, parentId)
    if (!parent) return badRequest('Parent folder does not exist')
  }

  const slug = slugFromTitle(name) || nanoid(8).toLowerCase()
  if (await isMediaFolderSlugTaken(db, parentId, slug)) {
    return badRequest(`A folder with the slug "${slug}" already exists here`)
  }

  const folder = await createMediaFolder(db, {
    id: nanoid(),
    parentId,
    name,
    slug,
    createdByUserId: user.id,
  })
  return jsonResponse({ folder }, { status: 201 })
}

async function handleUpdateFolder(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const user = await requireCapability(req, db, 'media.write')
  if (user instanceof Response) return user

  const folderId = params.id

  const body = await readValidatedBody(req, PatchFolderBodySchema)
  if (!body) return badRequest('Invalid request body')
  const existing = await getMediaFolder(db, folderId)
  if (!existing) return jsonResponse({ error: 'Folder not found' }, { status: 404 })

  const patch: UpdateMediaFolderInput = {}

  if (body.name !== undefined) {
    const name = body.name.trim()
    if (!name) return badRequest('A non-empty folder name is required')
    patch.name = name
    const slug = slugFromTitle(name) || nanoid(8).toLowerCase()
    // The slug derives from the name — the user can't set it directly.
    // Re-check uniqueness against the new (parent, slug) pair.
    const effectiveParent = body.parentId !== undefined ? body.parentId : existing.parentId
    if (await isMediaFolderSlugTaken(db, effectiveParent, slug, folderId)) {
      return badRequest(`A folder with the slug "${slug}" already exists here`)
    }
    patch.slug = slug
  }

  if (body.parentId !== undefined) {
    const parentRaw = body.parentId
    // Forbid making a folder its own ancestor — walk up the parent chain
    // from the candidate parent and reject if we run into `folderId`.
    if (parentRaw === folderId) {
      return badRequest('A folder cannot be its own parent')
    }
    if (parentRaw !== null) {
      let cursor: string | null = parentRaw
      while (cursor) {
        if (cursor === folderId) {
          return badRequest('A folder cannot be moved into its own descendant')
        }
        const ancestor = await getMediaFolder(db, cursor)
        cursor = ancestor?.parentId ?? null
      }
      const parent = await getMediaFolder(db, parentRaw)
      if (!parent) return badRequest('Target parent folder does not exist')
    }
    patch.parentId = parentRaw
  }

  if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder

  if (Object.keys(patch).length === 0) {
    return badRequest('No editable fields supplied')
  }

  const folder = await updateMediaFolder(db, folderId, patch)
  if (!folder) return jsonResponse({ error: 'Folder not found' }, { status: 404 })
  return jsonResponse({ folder })
}

async function handleDeleteFolder(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const user = await requireCapability(req, db, 'media.delete')
  if (user instanceof Response) return user

  const ok = await deleteMediaFolder(db, params.id)
  if (!ok) return jsonResponse({ error: 'Folder not found' }, { status: 404 })
  return jsonResponse({ ok: true })
}

// ---------------------------------------------------------------------------
// Route table + dispatcher
// ---------------------------------------------------------------------------

export const MEDIA_FOLDER_ROUTES: readonly Route<[]>[] = [
  { method: 'GET', pattern: FOLDERS_PATH, handler: handleListFolders },
  { method: 'POST', pattern: FOLDERS_PATH, handler: handleCreateFolder },
  {
    method: 'PATCH',
    pattern: new RegExp(`^${FOLDERS_PATH}/(?<id>[^/]+)$`),
    handler: handleUpdateFolder,
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^${FOLDERS_PATH}/(?<id>[^/]+)$`),
    handler: handleDeleteFolder,
  },
]

export async function handleMediaFolderRoutes(
  req: Request,
  db: DbClient,
): Promise<Response | null> {
  return runRouteTable(req, db, MEDIA_FOLDER_ROUTES)
}
