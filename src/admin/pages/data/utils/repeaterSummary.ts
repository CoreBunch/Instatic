import type { RepeaterItemField } from '@core/data/schemas'

const SUMMARY_FIELD_TYPES = new Set<RepeaterItemField['type']>([
  'text',
  'longText',
  'number',
  'boolean',
  'date',
  'dateTime',
  'select',
  'multiSelect',
  'url',
  'email',
])

export function isRepeaterSummaryField(field: RepeaterItemField): boolean {
  return SUMMARY_FIELD_TYPES.has(field.type)
}

function selectOptionLabel(
  field: Extract<RepeaterItemField, { type: 'select' | 'multiSelect' }>,
  optionId: string,
): string {
  return field.options.find((option) => option.id === optionId)?.label ?? optionId
}

export function readableRepeaterSummaryValue(
  field: RepeaterItemField,
  value: unknown,
): string | null {
  if (!isRepeaterSummaryField(field)) return null
  if (field.type === 'select' && typeof value === 'string' && value.trim()) {
    return selectOptionLabel(field, value)
  }
  if (field.type === 'multiSelect' && Array.isArray(value)) {
    const labels = value
      .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
      .map((entry) => selectOptionLabel(field, entry))
    return labels.length > 0 ? labels.join(', ') : null
  }
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return null
}
