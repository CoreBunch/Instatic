/**
 * Contextual current-entry-field loop source.
 *
 * Unlike database/site/plugin sources, this source is resolved synchronously
 * for every enclosing render iteration. A Project template can therefore
 * iterate `currentEntry.gallery`, while the same loop nested inside a
 * `data.rows` project listing resolves the gallery belonging to each project.
 */

import type {
  ContextualLoopEntitySource,
  LoopFetchResult,
  LoopItem,
} from '../types'

export const ENTRY_FIELD_SOURCE_ID = 'entry.field'
export const ENTRY_FIELD_FILTER_KEY = 'fieldId'

export interface EntryFieldMedia {
  publicPath: string
  mimeType?: string
  width?: number | null
  height?: number | null
  altText?: string
}

export interface ResolveEntryFieldItemsOptions {
  offset?: number
  limit?: number
  direction?: 'asc' | 'desc'
  mediaByReference?: ReadonlyMap<string, EntryFieldMedia>
}

function itemId(value: unknown, index: number): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>).id
    if (typeof candidate === 'string' && candidate) return candidate
  }
  if (typeof value === 'string' && value) return value
  return `entry-item-${index}`
}

function projectItem(
  value: unknown,
  index: number,
  mediaByReference: ReadonlyMap<string, EntryFieldMedia> | undefined,
): LoopItem {
  const id = itemId(value, index)

  if (typeof value === 'string') {
    const media = mediaByReference?.get(value)
    if (media) {
      return {
        id,
        fields: {
          id,
          value: media.publicPath,
          src: media.publicPath,
          url: media.publicPath,
          path: media.publicPath,
          altText: media.altText ?? '',
          mimeType: media.mimeType ?? '',
          width: media.width ?? null,
          height: media.height ?? null,
          index,
        },
      }
    }
    return { id, fields: { id, value, index } }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      id,
      fields: {
        ...(value as Record<string, unknown>),
        id,
        value,
        index,
      },
    }
  }

  return { id, fields: { id, value, index } }
}

/**
 * Turn an array-valued entry field into ordinary LoopItems.
 *
 * Media ids are enriched when the caller supplies the publisher/canvas media
 * map. Other primitives remain available as `currentEntry.value`; object
 * members are exposed directly while the original object remains at `value`.
 */
export function resolveEntryFieldItems(
  value: unknown,
  options: ResolveEntryFieldItemsOptions = {},
): LoopFetchResult {
  if (!Array.isArray(value)) return { items: [], totalItems: 0 }

  const direction = options.direction === 'desc' ? 'desc' : 'asc'
  const ordered = direction === 'desc' ? [...value].reverse() : value
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const limit = Math.max(1, Math.floor(options.limit ?? (ordered.length || 1)))
  const slice = ordered.slice(offset, offset + limit)

  return {
    items: slice.map((item, index) =>
      projectItem(item, offset + index, options.mediaByReference)),
    totalItems: value.length,
  }
}

export const EntryFieldSource: ContextualLoopEntitySource = {
  kind: 'contextual',
  id: ENTRY_FIELD_SOURCE_ID,
  label: 'Current entry field',
  description: 'Iterate an array field on the closest enclosing entry.',
  filterSchema: {
    [ENTRY_FIELD_FILTER_KEY]: {
      type: 'select',
      label: 'Field',
      options: [{ label: '— Choose an array field —', value: '' }],
    },
  },
  orderByOptions: [],
  fields: [
    { id: 'value', label: 'Value' },
    { id: 'index', label: 'Index' },
    { id: 'src', label: 'Media source', format: 'media' },
    { id: 'url', label: 'Media URL', format: 'url' },
    { id: 'path', label: 'Media path', format: 'media' },
    { id: 'altText', label: 'Alt text' },
    { id: 'mimeType', label: 'MIME type' },
    { id: 'width', label: 'Width' },
    { id: 'height', label: 'Height' },
  ],
}
