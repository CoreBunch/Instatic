/**
 * Media folder repository.
 *
 * Backs the HappyFiles-style folder tree on the Media page. Folders form a
 * tree via `parent_id` (null = root). Slugs are unique within a parent so
 * users can have two "Logos" folders under different roots.
 *
 * Asset membership is many-to-many through `media_asset_folders` — see
 * `repositories/media.ts → assignAssetToFolders` for that join.
 */
import type { DbClient } from '../db/client'
import { isoDate } from '@core/utils/isoDate'

interface MediaFolder {
  id: string
  parentId: string | null
  name: string
  slug: string
  sortOrder: number
  createdByUserId: string | null
  createdAt: string
}

interface CreateMediaFolderInput {
  id: string
  parentId: string | null
  name: string
  slug: string
  sortOrder?: number
  createdByUserId: string | null
}

export interface UpdateMediaFolderInput {
  name?: string
  slug?: string
  parentId?: string | null
  sortOrder?: number
}

interface MediaFolderRow {
  id: string
  parent_id: string | null
  name: string
  slug: string
  sort_order: number | string
  created_by_user_id: string | null
  created_at: Date | string
}

function mapFolder(row: MediaFolderRow): MediaFolder {
  return {
    id: row.id,
    parentId: row.parent_id ?? null,
    name: row.name,
    slug: row.slug,
    sortOrder: Number(row.sort_order),
    createdByUserId: row.created_by_user_id ?? null,
    createdAt: isoDate(row.created_at),
  }
}

export async function listMediaFolders(db: DbClient): Promise<MediaFolder[]> {
  const { rows } = await db<MediaFolderRow>`
    select id, parent_id, name, slug, sort_order, created_by_user_id, created_at
    from media_folders
    order by sort_order asc, lower(name) asc
  `
  return rows.map(mapFolder)
}

export async function getMediaFolder(
  db: DbClient,
  id: string,
): Promise<MediaFolder | null> {
  const { rows } = await db<MediaFolderRow>`
    select id, parent_id, name, slug, sort_order, created_by_user_id, created_at
    from media_folders
    where id = ${id}
  `
  return rows[0] ? mapFolder(rows[0]) : null
}

export async function createMediaFolder(
  db: DbClient,
  input: CreateMediaFolderInput,
): Promise<MediaFolder> {
  const sortOrder = input.sortOrder ?? 0
  const { rows } = await db<MediaFolderRow>`
    insert into media_folders (id, parent_id, name, slug, sort_order, created_by_user_id)
    values (
      ${input.id},
      ${input.parentId},
      ${input.name},
      ${input.slug},
      ${sortOrder},
      ${input.createdByUserId}
    )
    returning id, parent_id, name, slug, sort_order, created_by_user_id, created_at
  `
  return mapFolder(rows[0])
}

export async function updateMediaFolder(
  db: DbClient,
  id: string,
  input: UpdateMediaFolderInput,
): Promise<MediaFolder | null> {
  // COALESCE pattern — `undefined` → NULL → keep-existing — same trick used in
  // the assets repo. One query shape regardless of how many fields changed,
  // dialect-portable.
  const name = input.name ?? null
  const slug = input.slug ?? null
  // Distinguish "don't touch parent_id" from "set parent_id to NULL" by using
  // a sentinel: an explicit `null` parent (move to root) is opt-in by passing
  // `parentId: null`. To handle both cases we route through two query shapes.
  const sortOrder = input.sortOrder ?? null

  if (input.parentId !== undefined) {
    const { rows } = await db<MediaFolderRow>`
      update media_folders set
        name = coalesce(${name}, name),
        slug = coalesce(${slug}, slug),
        parent_id = ${input.parentId},
        sort_order = coalesce(${sortOrder}, sort_order)
      where id = ${id}
      returning id, parent_id, name, slug, sort_order, created_by_user_id, created_at
    `
    if (rows.length === 0) return null
    return mapFolder(rows[0])
  }

  const { rows } = await db<MediaFolderRow>`
    update media_folders set
      name = coalesce(${name}, name),
      slug = coalesce(${slug}, slug),
      sort_order = coalesce(${sortOrder}, sort_order)
    where id = ${id}
    returning id, parent_id, name, slug, sort_order, created_by_user_id, created_at
  `
  if (rows.length === 0) return null
  return mapFolder(rows[0])
}

/**
 * Delete a folder. `ON DELETE CASCADE` removes child folders and asset
 * membership rows automatically — the assets themselves stay (they just
 * become Uncategorized).
 */
export async function deleteMediaFolder(
  db: DbClient,
  id: string,
): Promise<boolean> {
  const result = await db`
    delete from media_folders where id = ${id}
  `
  return result.rowCount > 0
}

/**
 * Detect whether a (parent, slug) pair is already taken — used by the create
 * / rename handlers to return a friendly error rather than a raw unique
 * constraint violation.
 */
export async function isMediaFolderSlugTaken(
  db: DbClient,
  parentId: string | null,
  slug: string,
  excludeId?: string,
): Promise<boolean> {
  if (excludeId) {
    if (parentId === null) {
      const { rows } = await db<{ id: string }>`
        select id from media_folders
        where parent_id is null and slug = ${slug} and id <> ${excludeId}
        limit 1
      `
      return rows.length > 0
    }
    const { rows } = await db<{ id: string }>`
      select id from media_folders
      where parent_id = ${parentId} and slug = ${slug} and id <> ${excludeId}
      limit 1
    `
    return rows.length > 0
  }
  if (parentId === null) {
    const { rows } = await db<{ id: string }>`
      select id from media_folders
      where parent_id is null and slug = ${slug}
      limit 1
    `
    return rows.length > 0
  }
  const { rows } = await db<{ id: string }>`
    select id from media_folders
    where parent_id = ${parentId} and slug = ${slug}
    limit 1
  `
  return rows.length > 0
}
