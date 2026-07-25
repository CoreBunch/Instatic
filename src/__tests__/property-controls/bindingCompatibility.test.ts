import { describe, expect, it } from 'bun:test'
import {
  BINDING_COMPATIBILITY,
  getDynamicBindingMode,
  isFieldBindable,
  type PropertyControlKind,
} from '@site/property-controls/bindingCompatibility'
import type { DataMetaField } from '@core/data/schemas'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metaField(
  id: string,
  type: DataMetaField['type'],
  extras: Partial<DataMetaField> = {},
): DataMetaField {
  return { id, label: id, type, ...extras }
}

// ---------------------------------------------------------------------------
// Exhaustiveness — every PropertyControlKind must have an entry
// ---------------------------------------------------------------------------

describe('BINDING_COMPATIBILITY', () => {
  // All the known control kinds from propertySchema.ts
  const ALL_CONTROL_KINDS: PropertyControlKind[] = [
    'text', 'textarea', 'number', 'color', 'select', 'toggle',
    'image', 'media', 'url', 'dataTable', 'richtext', 'svg', 'group',
  ]

  it('has an entry for every PropertyControlKind', () => {
    for (const kind of ALL_CONTROL_KINDS) {
      expect(BINDING_COMPATIBILITY).toHaveProperty(kind)
    }
  })
})

// ---------------------------------------------------------------------------
// isFieldBindable — per-kind correctness
// ---------------------------------------------------------------------------

describe('isFieldBindable', () => {
  it('image + media(image) → true', () => {
    expect(isFieldBindable('image', metaField('f', 'media', { mediaKind: 'image' }))).toBe(true)
  })

  it('image + media(video) → false', () => {
    expect(isFieldBindable('image', metaField('f', 'media', { mediaKind: 'video' }))).toBe(false)
  })

  it('image + media (no mediaKind) → true (treated as any)', () => {
    expect(isFieldBindable('image', metaField('f', 'media'))).toBe(true)
  })

  it('media + media(video) → true', () => {
    expect(isFieldBindable('media', metaField('f', 'media', { mediaKind: 'video' }))).toBe(true)
  })

  it('media + media(image) → true', () => {
    expect(isFieldBindable('media', metaField('f', 'media', { mediaKind: 'image' }))).toBe(true)
  })

  it('image + media(allowMultiple) → false', () => {
    expect(isFieldBindable('image', metaField('f', 'media', { mediaKind: 'image', allowMultiple: true }))).toBe(false)
  })

  it('text + number → true', () => {
    expect(isFieldBindable('text', metaField('f', 'number'))).toBe(true)
  })

  it('toggle + text → false', () => {
    expect(isFieldBindable('toggle', metaField('f', 'text'))).toBe(false)
  })

  it('toggle + boolean → true', () => {
    expect(isFieldBindable('toggle', metaField('f', 'boolean'))).toBe(true)
  })

  it('color + select → false', () => {
    expect(isFieldBindable('color', metaField('f', 'select'))).toBe(false)
  })

  it('select + select → false', () => {
    expect(isFieldBindable('select', metaField('f', 'select'))).toBe(false)
  })

  it('color + text → false', () => {
    expect(isFieldBindable('color', metaField('f', 'text'))).toBe(false)
  })

  it('richtext + richText → true', () => {
    expect(isFieldBindable('richtext', metaField('f', 'richText'))).toBe(true)
  })

  it('richtext + longText → true', () => {
    expect(isFieldBindable('richtext', metaField('f', 'longText'))).toBe(true)
  })

  it('number + boolean → false', () => {
    expect(isFieldBindable('number', metaField('f', 'boolean'))).toBe(false)
  })

  it('url + email → true', () => {
    expect(isFieldBindable('url', metaField('f', 'email'))).toBe(true)
  })

  it('url + text → true (a slug composes into an href token)', () => {
    expect(isFieldBindable('url', metaField('f', 'text'))).toBe(true)
  })

  it('url + boolean → false', () => {
    expect(isFieldBindable('url', metaField('f', 'boolean'))).toBe(false)
  })

  it('url + richText → false (markup is not a URL fragment)', () => {
    expect(isFieldBindable('url', metaField('f', 'richText'))).toBe(false)
  })

  it('group + text → false (group has no bindings)', () => {
    expect(isFieldBindable('group', metaField('f', 'text'))).toBe(false)
  })
})

describe('getDynamicBindingMode', () => {
  it('uses token mode for free text controls', () => {
    expect(getDynamicBindingMode({ type: 'text', label: 'Text' })).toBe('token')
    expect(getDynamicBindingMode({ type: 'textarea', label: 'Body' })).toBe('token')
    expect(getDynamicBindingMode({ type: 'url', label: 'URL' })).toBe('token')
  })

  it('skips identifier-normalized text controls', () => {
    expect(getDynamicBindingMode({ type: 'text', label: 'Form ID', normalize: 'identifier' })).toBeNull()
  })

  it('uses structured mode for whole-prop value controls', () => {
    expect(getDynamicBindingMode({ type: 'image', label: 'Image' })).toBe('structured')
    expect(getDynamicBindingMode({ type: 'media', mediaKind: 'video', label: 'Video' })).toBe('structured')
    expect(getDynamicBindingMode({ type: 'number', label: 'Rows' })).toBe('structured')
    expect(getDynamicBindingMode({ type: 'toggle', label: 'Required' })).toBe('structured')
  })

  it('skips fixed choices and structural controls', () => {
    expect(getDynamicBindingMode({
      type: 'select',
      label: 'Loading',
      options: [{ label: 'Lazy', value: 'lazy' }],
    })).toBeNull()
    expect(getDynamicBindingMode({ type: 'color', label: 'Color' })).toBeNull()
    expect(getDynamicBindingMode({ type: 'svg', label: 'SVG' })).toBeNull()
    expect(getDynamicBindingMode({ type: 'dataTable', label: 'Table' })).toBeNull()
  })
})
