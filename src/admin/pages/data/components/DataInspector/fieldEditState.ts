/**
 * fieldEditState — the draft edit-state shape for the inline field editor, the
 * option constants for type-specific selects, and the pure conversions between
 * a persisted DataField and its editable draft.
 *
 * No JSX lives here — FieldEditForm renders this state, FieldsSection owns it.
 */
import {
  type DataField,
  type DataSelectOption,
} from '@core/data/schemas'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DraftOption {
  id: string
  label: string
  value: string
}

export interface FieldEditState {
  label: string
  required: boolean
  description: string
  // text
  textMaxLength: string
  textPlaceholder: string
  // richText
  richTextFormat: 'markdown' | 'html'
  // number
  numberMin: string
  numberMax: string
  numberStep: string
  numberInteger: boolean
  numberFormat: 'number' | 'currency' | 'percent'
  numberCurrency: string
  // boolean
  booleanDefault: boolean
  // select / multiSelect
  selectOptions: DraftOption[]
  // media
  mediaKind: 'image' | 'video' | 'any'
  mediaAllowMultiple: boolean
  // relation
  relationAllowMultiple: boolean
}

// ---------------------------------------------------------------------------
// Option constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

export function fieldToEditState(field: DataField): FieldEditState {
  return {
    label: field.label,
    required: field.required ?? false,
    description: field.description ?? '',
    textMaxLength: field.type === 'text' ? (field.maxLength?.toString() ?? '') : '',
    textPlaceholder: field.type === 'text' ? (field.placeholder ?? '') : '',
    richTextFormat: field.type === 'richText' ? field.format : 'markdown',
    numberMin: field.type === 'number' ? (field.min?.toString() ?? '') : '',
    numberMax: field.type === 'number' ? (field.max?.toString() ?? '') : '',
    numberStep: field.type === 'number' ? (field.step?.toString() ?? '') : '',
    numberInteger: field.type === 'number' ? (field.integer ?? false) : false,
    numberFormat: field.type === 'number' ? (field.format ?? 'number') : 'number',
    numberCurrency: field.type === 'number' ? (field.currency ?? '') : '',
    booleanDefault: field.type === 'boolean' ? (field.defaultValue ?? false) : false,
    selectOptions:
      field.type === 'select' || field.type === 'multiSelect'
        ? field.options.map((o) => ({ id: o.id, label: o.label, value: o.value }))
        : [makeOption('')],
    mediaKind: field.type === 'media' ? (field.mediaKind ?? 'any') : 'any',
    mediaAllowMultiple: field.type === 'media' ? (field.allowMultiple ?? false) : false,
    relationAllowMultiple: field.type === 'relation' ? (field.allowMultiple ?? false) : false,
  }
}

export function applyEditState(
  field: DataField,
  state: FieldEditState,
  labelLocked: boolean,
): DataField {
  const common = {
    id: field.id,
    label: labelLocked ? field.label : (state.label.trim() || field.label),
    ...(state.required ? { required: true as const } : {}),
    ...(state.description.trim() ? { description: state.description.trim() } : {}),
    ...(field.builtIn ? { builtIn: true as const } : {}),
  }

  switch (field.type) {
    case 'text':
      return {
        type: 'text',
        ...common,
        ...(state.textMaxLength ? { maxLength: Number(state.textMaxLength) } : {}),
        ...(state.textPlaceholder.trim() ? { placeholder: state.textPlaceholder.trim() } : {}),
      }
    case 'longText':
      return { type: 'longText', ...common }
    case 'richText':
      return { type: 'richText', ...common, format: state.richTextFormat }
    case 'number':
      return {
        type: 'number',
        ...common,
        ...(state.numberMin !== '' ? { min: Number(state.numberMin) } : {}),
        ...(state.numberMax !== '' ? { max: Number(state.numberMax) } : {}),
        ...(state.numberStep !== '' ? { step: Number(state.numberStep) } : {}),
        ...(state.numberInteger ? { integer: true as const } : {}),
        ...(state.numberFormat !== 'number' ? { format: state.numberFormat } : {}),
        ...(state.numberFormat === 'currency' && state.numberCurrency.trim()
          ? { currency: state.numberCurrency.trim() }
          : {}),
      }
    case 'boolean':
      return {
        type: 'boolean',
        ...common,
        ...(state.booleanDefault ? { defaultValue: true as const } : {}),
      }
    case 'date':
      return { type: 'date', ...common }
    case 'dateTime':
      return { type: 'dateTime', ...common }
    case 'select': {
      const options: DataSelectOption[] = state.selectOptions
        .filter((o) => o.label.trim())
        .map((o) => ({
          id: o.id,
          label: o.label.trim(),
          value: o.value || slugifyOptionValue(o.label),
        }))
      return { type: 'select', ...common, options }
    }
    case 'multiSelect': {
      const options: DataSelectOption[] = state.selectOptions
        .filter((o) => o.label.trim())
        .map((o) => ({
          id: o.id,
          label: o.label.trim(),
          value: o.value || slugifyOptionValue(o.label),
        }))
      return { type: 'multiSelect', ...common, options }
    }
    case 'url':
      return { type: 'url', ...common }
    case 'email':
      return { type: 'email', ...common }
    case 'media':
      return {
        type: 'media',
        ...common,
        ...(state.mediaKind !== 'any' ? { mediaKind: state.mediaKind } : {}),
        ...(state.mediaAllowMultiple ? { allowMultiple: true as const } : {}),
      }
    case 'relation':
      return {
        type: 'relation',
        ...common,
        targetTableId: field.targetTableId,
        ...(state.relationAllowMultiple ? { allowMultiple: true as const } : {}),
      }
    case 'pageTree':
      return { type: 'pageTree', ...common }
    case 'fieldSchema':
      return { type: 'fieldSchema', ...common }
    case 'seoMetadata':
      return { type: 'seoMetadata', ...common }
    default: {
      const _exhaustive: never = field
      void _exhaustive
      return field
    }
  }
}
