/**
 * Built-in `site.media` loop source — iterates uploaded media assets.
 *
 * Reads from the `media_assets` table. Filters by mime-type prefix so a
 * loop can show "all images", "all videos", or unfiltered.
 *
 * Order options:
 *   - createdAt — upload time (newest/oldest first)
 *   - filename  — alphabetical
 */

import type { LoopEntitySource, LoopFetchResult, LoopItem, LoopSourceDb } from '@core/loops/types'
import { isoDate } from '../../utils/isoDate'

interface MediaRow {
  id: string
  filename: string
  mime_type: string
  size_bytes: number | string
  public_path: string
  uploaded_by_user_id: string | null
  created_at: Date | string
}

function rowToLoopItem(row: MediaRow): LoopItem {
  return {
    id: row.id,
    fields: {
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      path: row.public_path,
      url: row.public_path,
      src: row.public_path,
      uploadedByUserId: row.uploaded_by_user_id,
      uploadedById: row.uploaded_by_user_id,
      createdAt: isoDate(row.created_at),
    },
  }
}

async function countMedia(db: LoopSourceDb, mimePrefix: string): Promise<number> {
  if (mimePrefix) {
    const { rows } = await db<{ total: number }>`
      select count(*) as total
      from media_assets
      where deleted_at is null
        and mime_type like ${mimePrefix + '%'}
    `
    return Number(rows[0]?.total ?? 0)
  }
  const { rows } = await db<{ total: number }>`
    select count(*) as total
    from media_assets
    where deleted_at is null
  `
  return Number(rows[0]?.total ?? 0)
}

async function fetchMediaPage(
  db: LoopSourceDb,
  mimePrefix: string,
  orderBy: 'createdAt' | 'filename',
  direction: 'asc' | 'desc',
  limit: number,
  offset: number,
): Promise<MediaRow[]> {
  // Each branch hard-codes its ORDER BY column so we never concatenate
  // identifier strings into the SQL — same approach as ContentEntriesSource.
  if (orderBy === 'filename' && direction === 'asc') {
    if (mimePrefix) {
      const { rows } = await db<MediaRow>`
        select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at
        from media_assets
        where deleted_at is null and mime_type like ${mimePrefix + '%'}
        order by filename asc, id asc
        limit ${limit} offset ${offset}
      `
      return rows
    }
    const { rows } = await db<MediaRow>`
      select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at
      from media_assets
      where deleted_at is null
      order by filename asc, id asc
      limit ${limit} offset ${offset}
    `
    return rows
  }
  if (orderBy === 'filename' && direction === 'desc') {
    if (mimePrefix) {
      const { rows } = await db<MediaRow>`
        select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at
        from media_assets
        where deleted_at is null and mime_type like ${mimePrefix + '%'}
        order by filename desc, id desc
        limit ${limit} offset ${offset}
      `
      return rows
    }
    const { rows } = await db<MediaRow>`
      select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at
      from media_assets
      where deleted_at is null
      order by filename desc, id desc
      limit ${limit} offset ${offset}
    `
    return rows
  }
  // createdAt
  if (direction === 'asc') {
    if (mimePrefix) {
      const { rows } = await db<MediaRow>`
        select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at
        from media_assets
        where deleted_at is null and mime_type like ${mimePrefix + '%'}
        order by created_at asc, id asc
        limit ${limit} offset ${offset}
      `
      return rows
    }
    const { rows } = await db<MediaRow>`
      select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at
      from media_assets
      where deleted_at is null
      order by created_at asc, id asc
      limit ${limit} offset ${offset}
    `
    return rows
  }
  if (mimePrefix) {
    const { rows } = await db<MediaRow>`
      select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at
      from media_assets
      where deleted_at is null and mime_type like ${mimePrefix + '%'}
      order by created_at desc, id desc
      limit ${limit} offset ${offset}
    `
    return rows
  }
  const { rows } = await db<MediaRow>`
    select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at
    from media_assets
    where deleted_at is null
    order by created_at desc, id desc
    limit ${limit} offset ${offset}
  `
  return rows
}

export const SiteMediaSource: LoopEntitySource = {
  id: 'site.media',
  label: 'Media library',
  description: 'Loop uploaded media assets — filter by mime-type to scope to images or videos.',

  filterSchema: {
    mimePrefix: {
      type: 'select',
      label: 'Media type',
      options: [
        { label: 'All', value: '' },
        { label: 'Images', value: 'image/' },
        { label: 'Videos', value: 'video/' },
        { label: 'Audio', value: 'audio/' },
      ],
    },
  },

  // Newest first unless the author picks otherwise.
  defaultDirection: 'desc',
  orderByOptions: [
    { id: 'createdAt', label: 'Upload date' },
    { id: 'filename', label: 'Filename' },
  ],

  fields: [
    { id: 'filename', label: 'Filename' },
    { id: 'path', label: 'Path', format: 'url' },
    { id: 'url', label: 'URL', format: 'url' },
    { id: 'src', label: 'Source URL', format: 'media' },
    { id: 'mimeType', label: 'MIME type' },
    { id: 'createdAt', label: 'Upload date' },
  ],

  async fetch(ctx): Promise<LoopFetchResult> {
    const mimePrefix =
      typeof ctx.filters.mimePrefix === 'string' ? ctx.filters.mimePrefix : ''
    const orderBy: 'createdAt' | 'filename' =
      ctx.orderBy === 'filename' ? 'filename' : 'createdAt'
    const direction: 'asc' | 'desc' = ctx.direction === 'asc' ? 'asc' : 'desc'

    const totalItems = await countMedia(ctx.db, mimePrefix)
    if (totalItems === 0) return { items: [], totalItems: 0 }

    const rows = await fetchMediaPage(
      ctx.db,
      mimePrefix,
      orderBy,
      direction,
      ctx.limit,
      ctx.offset,
    )
    return {
      items: rows.map(rowToLoopItem),
      totalItems,
    }
  },
}
