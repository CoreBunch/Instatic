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

const FIELD_ID_PATTERN = /^[a-z][a-z0-9_]*$/

export function slugifyOptionValue(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function makeOption(label: string): DraftOption {
  return { id: crypto.randomUUID(), label, value: slugifyOptionValue(label) }
}

export function fieldIdError(id: string, existingIds: string[]): string | null {
  if (!id) return null
  if (!FIELD_ID_PATTERN.test(id)) return 'Must start with a lowercase letter; use letters, numbers, underscores only.'
  if (existingIds.includes(id)) return 'This ID is already in use.'
  return null
}
