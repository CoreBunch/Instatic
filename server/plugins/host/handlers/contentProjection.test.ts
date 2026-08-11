import { describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { ContentTableSchemaSchema } from '@core/plugin-sdk/contentSchemas'
import type { DataTable } from '@core/data/schemas'
import { tableSchema } from './contentProjection'

describe('content projection', () => {
  it('projects repeater item fields across the plugin boundary', () => {
    const table: DataTable = {
      id: 'projects-id',
      name: 'Projects',
      slug: 'projects',
      kind: 'postType',
      singularLabel: 'Project',
      pluralLabel: 'Projects',
      routeBase: '/projects',
      primaryFieldId: 'title',
      fields: [
        { type: 'text', id: 'title', label: 'Title' },
        {
          type: 'repeater',
          id: 'gallery',
          label: 'Gallery',
          itemLabelFieldId: 'caption',
          fields: [
            { type: 'text', id: 'caption', label: 'Caption', required: true },
            {
              type: 'media',
              id: 'images',
              label: 'Images',
              mediaKind: 'image',
              allowMultiple: true,
            },
            {
              type: 'relation',
              id: 'credit',
              label: 'Credit',
              targetTableId: 'people-id',
            },
          ],
        },
      ],
      system: false,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    }

    const projected = tableSchema(
      table,
      2,
      new Map([['people-id', 'people']]),
    )

    expect(projected.fields[1]).toEqual({
      type: 'repeater',
      id: 'gallery',
      label: 'Gallery',
      required: undefined,
      itemLabelFieldId: 'caption',
      fields: [
        {
          type: 'text',
          id: 'caption',
          label: 'Caption',
          required: true,
        },
        {
          type: 'media',
          id: 'images',
          label: 'Images',
          mediaKind: 'image',
          allowMultiple: true,
        },
        {
          type: 'relation',
          id: 'credit',
          label: 'Credit',
          targetTableSlug: 'people',
          allowMultiple: undefined,
        },
      ],
    })
    expect(Value.Check(ContentTableSchemaSchema, projected)).toBe(true)
  })
})
