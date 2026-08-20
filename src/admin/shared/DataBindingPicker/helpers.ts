/**
 * Pure helpers, types and constants for the shared data-binding picker.
 *
 * Lives in a `.ts` file (no JSX) so React Fast Refresh continues to work
 * for the sibling `.tsx` component files.
 */

import type { DataMeta, DataMetaField, DataMetaTable, DataRow } from '@core/data/schemas'
import type { DynamicPropBinding } from '@core/page-tree'
import type { LoopSourceField } from '@core/loops/types'
import { SYSTEM_SOURCES, type SystemSourceId } from './systemSources'
import type { PropertyControlKind } from './bindingCompatibility'

// ---------------------------------------------------------------------------
// Field-list entry shape — one of three kinds depending on the active scope
// ---------------------------------------------------------------------------

export type FieldEntry =
  | { kind: 'meta'; field: DataMetaField }
  | { kind: 'data'; table: DataMetaTable; row: DataRow; field: DataMetaField }
  | { kind: 'loop'; field: LoopSourceField }
  | { kind: 'system'; source: SystemSourceId; field: LoopSourceField }

export type FieldGroup = { label: string; entries: FieldEntry[] }

// ---------------------------------------------------------------------------
// Loop source field compat (format-based, not type-based)
//
// Loop synthetic fields and system-source fields use the same `LoopSourceField`
// shape, so they share this compat rule.
// ---------------------------------------------------------------------------

export function loopFieldMatchesControl(
  field: LoopSourceField,
  controlKind: PropertyControlKind,
): boolean {
  switch (controlKind) {
    case 'image':
    case 'media':
      return field.format === 'media'
    case 'richtext':
      return field.format === 'html'
    case 'text':
    case 'textarea':
      return field.format !== 'media' && field.format !== 'html'
    case 'url':
      return field.format === 'url' || field.format === 'media'
    case 'number':
    case 'toggle':
    case 'color':
    case 'select':
      return false
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Preview value formatter — renders a LoopItem / frame field value as a
// short, human-readable string for the per-row value pill in the picker.
// Stays defensive: any unknown shape becomes a JSON snippet so authors can
// still tell what the binding would resolve to.
// ---------------------------------------------------------------------------

export function formatPreviewValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') {
    if (!value) return '(empty)'
    return value.length > 80 ? `${value.slice(0, 80)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '(empty)'
    return value.map((v) => formatPreviewValue(v)).join(', ')
  }
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value)
      return json.length > 80 ? `${json.slice(0, 80)}…` : json
    } catch {
      return '[object]'
    }
  }
  return String(value)
}

/**
 * Use concise, semantic summaries for structured Data fields. Token insertion
 * supports their whole stored value, but dumping media ids or repeater JSON
 * into a narrow picker row does not help authors recognize populated fields.
 */
export function formatMetaFieldPreview(
  field: DataMetaField,
  value: unknown,
): string {
  if (field.type === 'repeater') {
    if (!Array.isArray(value) || value.length === 0) return '(empty)'
    return `${value.length} ${value.length === 1 ? 'item' : 'items'}`
  }

  if (field.type === 'media') {
    const values = Array.isArray(value)
      ? value.filter((entry) => typeof entry === 'string' && entry.length > 0)
      : typeof value === 'string' && value.length > 0
        ? [value]
        : []
    if (values.length === 0) return '(empty)'
    const noun = field.mediaKind === 'image'
      ? 'image'
      : field.mediaKind === 'video'
        ? 'video'
        : 'asset'
    return `${values.length} ${values.length === 1 ? noun : `${noun}s`}`
  }

  return formatPreviewValue(value)
}

// ---------------------------------------------------------------------------
// Format derivation when building the binding
//
// Maps a (controlKind, fieldType) pair to the `format` slot of a
// `DynamicPropBinding`. `undefined` means "no explicit format" (the
// resolver picks the default plain-text path).
// ---------------------------------------------------------------------------

export function deriveFormat(
  controlKind: PropertyControlKind,
  fieldType: DataMetaField['type'],
): DynamicPropBinding['format'] | undefined {
  if (fieldType === 'media') return 'media'
  if (
    (fieldType === 'richText' || fieldType === 'longText') &&
    (controlKind === 'richtext' || controlKind === 'textarea')
  ) {
    return 'html'
  }
  return undefined
}

/**
 * Translate a `LoopSourceField` format (loop synthetics + system sources)
 * to the matching binding format. Same shape on both sides; this exists
 * so callers don't have to know that the strings line up.
 */
export function loopFieldFormat(
  format: LoopSourceField['format'],
): DynamicPropBinding['format'] | undefined {
  if (format === 'html') return 'html'
  if (format === 'url') return 'url'
  if (format === 'media') return 'media'
  return undefined
}

// ---------------------------------------------------------------------------
// Resolved binding label for the bound-state badge
// ---------------------------------------------------------------------------

export function resolveBindingLabel(
  binding: DynamicPropBinding,
  availableFields: LoopSourceField[] | undefined,
  sourceLabel: string | undefined,
  meta: DataMeta | null,
): string {
  // System sources first — checked by `binding.source`, not by field id
  // alone, because the same field id ('id', 'slug') can exist on
  // multiple system sources.
  if (
    binding.source === 'page' ||
    binding.source === 'site' ||
    binding.source === 'route'
  ) {
    const system = SYSTEM_SOURCES.find((s) => s.id === binding.source)
    if (system) {
      const field = system.fields.find((f) => f.id === binding.field)
      const fieldLabel = field?.label ?? binding.field
      return `${system.label} → ${fieldLabel}`
    }
  }
  // Loop source fields
  if (availableFields && availableFields.length > 0) {
    const match = availableFields.find((f) => f.id === binding.field)
    if (match) {
      const prefix = sourceLabel ? `${sourceLabel} → ` : ''
      return `${prefix}${match.label}`
    }
  }
  // DataMeta tables
  if (meta) {
    for (const table of meta.tables) {
      const field = table.fields.find((f) => f.id === binding.field)
      if (field) return `${table.name} → ${field.label}`
    }
  }
  // Fallback: humanise the field id
  return `Current entry → ${binding.field}`
}
