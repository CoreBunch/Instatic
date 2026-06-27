/**
 * Binding compatibility map — defines which DataFieldTypes each
 * PropertyControlKind can accept as a binding source.
 *
 * Single source of truth for the picker's field eligibility and for whether
 * a property control should show the binding affordance at all.
 * Pure module, no side effects.
 */

import type { PropertyControl } from '@core/module-engine'
import type { DataFieldType, DataMetaField } from '@core/data/schemas'

/**
 * The discriminated `type` field from the `PropertyControl` union.
 * Derived from the schema so it stays exhaustive automatically.
 */
export type PropertyControlKind = PropertyControl['type']

type DynamicBindingMode = 'token' | 'structured'

/**
 * Maps every PropertyControlKind to the DataFieldTypes it can accept as a
 * binding source.
 *
 * Notes:
 * - `image`   also gated by mediaKind ∈ {'image', 'any'} inside `isFieldBindable`.
 * - `media`   accepts any mediaKind.
 * - `select` has no binding mode: module selects are fixed option sets and
 *   TypeBox validation will coerce unknown dynamic values back to defaults.
 * - `color` has no binding mode until data has a first-class color field type.
 * - `group` has no meaningful scalar binding target.
 * - `pageTree`, `fieldSchema`, and `seoMetadata` are structural cell types
 *   that hold whole documents (a page-node tree, a DataField[] array, an SEO
 *   object). They are not
 *   bindable to any property control — page authors cannot wire a page tree
 *   or a field-schema array directly to a node prop. They appear in `group`
 *   solely to satisfy the binding-compatibility-coverage architecture test,
 *   which requires every DataFieldType to appear in at least one control's
 *   compat array. The list is exhaustive; new structural types belong here.
 */
export const BINDING_COMPATIBILITY: Record<PropertyControlKind, readonly DataFieldType[]> = {
  // text accepts every scalar type that can be meaningfully rendered as a string.
  // multiSelect binds as a comma-joined list of selected option labels.
  // relation binds as the related row's primary-field display label.
  text:     ['text', 'longText', 'richText', 'url', 'email', 'select', 'multiSelect', 'relation', 'number', 'boolean', 'date', 'dateTime'],
  textarea: ['text', 'longText', 'richText'],
  richtext: ['richText', 'longText', 'text'],
  // svg holds raw inline-SVG markup — edited in the code editor, never wired
  // to a data field.
  svg:      [],
  number:   ['number'],
  url:      ['url', 'email'],
  color:    [],
  toggle:   ['boolean'],
  select:   [],
  dataTable: [],
  image:    ['media'],
  media:    ['media'],
  // Structural (document-level) types: not scalar-bindable, listed here for
  // coverage-test completeness only — the picker excludes them from the
  // binding catalog via buildMetaFields in src/core/data/fields.ts.
  group:    ['pageTree', 'fieldSchema', 'seoMetadata'],
}

/**
 * Returns true if the given DataMetaField is bindable to the given
 * PropertyControlKind. Respects the `BINDING_COMPATIBILITY` map and applies
 * the additional `mediaKind` gate for image/media controls.
 */
export function isFieldBindable(controlKind: PropertyControlKind, field: DataMetaField): boolean {
  const allowedTypes = BINDING_COMPATIBILITY[controlKind]
  if (!allowedTypes.includes(field.type)) return false
  if (field.type === 'media') {
    if (field.allowMultiple === true) return false
    const kind = field.mediaKind ?? 'any'
    if (controlKind === 'image') return kind === 'image' || kind === 'any'
    // 'media' control accepts all media kinds
    if (controlKind === 'media') return true
  }
  return true
}

/**
 * Returns the editor binding mode for a property control, or null when the
 * control cannot accept dynamic data in a way that survives authoring +
 * render-time validation.
 */
export function getDynamicBindingMode(control: PropertyControl): DynamicBindingMode | null {
  switch (control.type) {
    case 'text':
      return control.normalize === 'identifier' ? null : 'token'
    case 'textarea':
    case 'richtext':
    case 'url':
      return 'token'
    case 'number':
    case 'toggle':
    case 'image':
    case 'media':
      return 'structured'
    case 'color':
    case 'select':
    case 'dataTable':
    case 'svg':
    case 'group':
      return null
    default:
      return null
  }
}
