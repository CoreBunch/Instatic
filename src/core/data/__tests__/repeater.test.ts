import { describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { readRepeaterCell } from '../cells'
import {
  DataFieldSchema,
  RepeaterValueSchema,
  type DataField,
} from '../schemas'

const galleryField: DataField = {
  type: 'repeater',
  id: 'gallery',
  label: 'Gallery',
  itemLabelFieldId: 'caption',
  fields: [
    { type: 'media', id: 'image', label: 'Image', mediaKind: 'image' },
    { type: 'text', id: 'caption', label: 'Caption' },
  ],
}

describe('repeater data fields', () => {
  it('validates one-level ordinary item fields', () => {
    expect(Value.Check(DataFieldSchema, galleryField)).toBe(true)
  })

  it('rejects nested repeaters', () => {
    const nested = {
      type: 'repeater',
      id: 'sections',
      label: 'Sections',
      fields: [{
        type: 'repeater',
        id: 'items',
        label: 'Items',
        fields: [{ type: 'text', id: 'name', label: 'Name' }],
      }],
    }

    expect(Value.Check(DataFieldSchema, nested)).toBe(false)
  })

  it('preserves stable ids and ordered item cells', () => {
    const value = [
      { id: 'shot-1', cells: { image: 'media-1', caption: 'Opening frame' } },
      { id: 'shot-2', cells: { image: 'media-2', caption: 'Closing frame' } },
    ]

    expect(Value.Check(RepeaterValueSchema, value)).toBe(true)
    expect(readRepeaterCell({ gallery: value }, 'gallery')).toEqual(value)
  })

  it('degrades malformed stored values to an empty collection', () => {
    expect(readRepeaterCell({ gallery: [{ cells: { caption: 'Missing id' } }] }, 'gallery')).toEqual([])
    expect(readRepeaterCell({ gallery: 'not-an-array' }, 'gallery')).toEqual([])
  })
})
