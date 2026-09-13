import { nanoid } from 'nanoid'
import type { DataFieldType } from '@core/data/schemas'

export interface DraftOption {
  id: string
  label: string
  value: string
}

export const FIELD_TYPE_OPTIONS: ReadonlyArray<{ value: DataFieldType; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'longText', label: 'Long text' },
  { value: 'richText', label: 'Rich text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'date', label: 'Date' },
  { value: 'dateTime', label: 'Date & time' },
  { value: 'select', label: 'Select' },
  { value: 'multiSelect', label: 'Multi-select' },
  { value: 'url', label: 'URL' },
  { value: 'email', label: 'Email' },
  { value: 'media', label: 'Media' },
  { value: 'relation', label: 'Relation' },
  { value: 'repeater', label: 'Repeater' },
]

export const RICH_TEXT_FORMAT_OPTIONS = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'html', label: 'HTML' },
]

export const NUMBER_FORMAT_OPTIONS = [
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'percent', label: 'Percent' },
]

export const MEDIA_KIND_OPTIONS = [
  { value: 'any', label: 'Any' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
]

/**
 * Field ids must start with a lowercase letter so they stay safe as token
 * and binding keys, but the body accepts any letter case.
 *
 * camelCase is deliberately allowed: the storage schema puts no pattern on
 * `id` at all (`FieldCommonProps.id` is a bare `Type.String()`), the API
 * accepts camelCase today, and three of the built-in post-type fields —
 * `featuredMedia`, `seoTitle`, `seoDescription` — are themselves camelCase.
 * Rejecting it here was the only thing forcing a second convention into
 * tables that already carry the first.
 */
const FIELD_ID_PATTERN = /^[a-z][a-zA-Z0-9_]*$/

export function slugifyOptionValue(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function fieldIdFromLabel(label: string): string {
  const normalized = slugifyOptionValue(
    label.normalize('NFKD').replace(/\p{Diacritic}/gu, ''),
  )
  if (!normalized) return ''
  return /^[a-z]/.test(normalized) ? normalized : `field_${normalized}`
}

export function makeOption(label: string): DraftOption {
  return { id: nanoid(), label, value: slugifyOptionValue(label) }
}

export function fieldIdError(id: string, existingIds: string[]): string | null {
  if (!id) return null
  if (!FIELD_ID_PATTERN.test(id)) return 'Must start with a lowercase letter, then letters, numbers or underscores.'
  if (existingIds.includes(id)) return 'This ID is already in use.'
  return null
}
