/**
 * Unit tests for buildDataMeta() in src/core/data/fields.ts.
 *
 * Tests the transformation from a DataTable[] to the lean DataMeta shape
 * independently of HTTP — no server, no DB, no auth.
 */
import { describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { buildDataMeta } from '@core/data/fields'
import { DataMetaSchema } from '@core/data/schemas'
import type { DataTable } from '@core/data/schemas'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePostTypeTable(overrides: Partial<DataTable> = {}): DataTable {
  return {
    id: 'table-posts',
    name: 'Posts',
    slug: 'posts',
    kind: 'postType',
    singularLabel: 'Post',
    pluralLabel: 'Posts',
    routeBase: '/posts',
    primaryFieldId: 'title',
    fields: [
      { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
      { type: 'text', id: 'slug', label: 'Slug', required: true, builtIn: true },
      { type: 'richText', id: 'body', label: 'Body', format: 'markdown', builtIn: true },
      { type: 'media', id: 'featuredMedia', label: 'Featured media', mediaKind: 'image', builtIn: true },
      { type: 'text', id: 'seoTitle', label: 'SEO title', builtIn: true },
      { type: 'longText', id: 'seoDescription', label: 'SEO description', builtIn: true },
    ],
    system: false,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  }
}

function makeDataTable(overrides: Partial<DataTable> = {}): DataTable {
  return {
    id: 'table-products',
    name: 'Products',
    slug: 'products',
    kind: 'data',
    singularLabel: 'Product',
    pluralLabel: 'Products',
    routeBase: '',
    primaryFieldId: 'name',
    fields: [
      { type: 'text', id: 'name', label: 'Name', required: true },
      { type: 'number', id: 'price', label: 'Price' },
    ],
    system: false,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildDataMeta', () => {
  it('returns empty tables array for empty input', () => {
    const meta = buildDataMeta([])
    expect(meta).toEqual({ tables: [] })
    expect(Value.Check(DataMetaSchema, meta)).toBe(true)
  })

  it('maps a post-type table with correct routable and versioned flags', () => {
    const meta = buildDataMeta([makePostTypeTable()])

    expect(meta.tables).toHaveLength(1)
    const table = meta.tables[0]

    expect(table).toMatchObject({
      id: 'table-posts',
      slug: 'posts',
      name: 'Posts',
      kind: 'postType',
      singularLabel: 'Post',
      pluralLabel: 'Posts',
      primaryFieldId: 'title',
      routable: true,    // routeBase: '/posts' → non-empty
      versioned: true,   // kind: 'postType'
    })
  })

  it('maps a data-kind table with routable: false and versioned: false', () => {
    const meta = buildDataMeta([makeDataTable()])
    const table = meta.tables[0]

    expect(table.kind).toBe('data')
    expect(table.routable).toBe(false)  // routeBase: ''
    expect(table.versioned).toBe(false) // kind: 'data'
  })

  it('maps a post-type table with all 6 built-in fields to correct meta fields', () => {
    const meta = buildDataMeta([makePostTypeTable()])
    const fields = meta.tables[0].fields

    // 6 fields: title, slug, body (richText), featuredMedia (media), seoTitle, seoDescription
    expect(fields).toHaveLength(6)

    expect(fields.find((f) => f.id === 'title')).toMatchObject({ type: 'text', label: 'Title' })
    expect(fields.find((f) => f.id === 'slug')).toMatchObject({ type: 'text', label: 'Slug' })
    expect(fields.find((f) => f.id === 'body')).toMatchObject({ type: 'richText', label: 'Body' })
    expect(fields.find((f) => f.id === 'seoTitle')).toMatchObject({ type: 'text', label: 'SEO title' })
    expect(fields.find((f) => f.id === 'seoDescription')).toMatchObject({ type: 'longText', label: 'SEO description' })
  })

  it('copies mediaKind and allowMultiple from media fields', () => {
    const table = makePostTypeTable({
      fields: [
        { type: 'media', id: 'photo', label: 'Photo', mediaKind: 'image', allowMultiple: false },
        { type: 'media', id: 'gallery', label: 'Gallery', mediaKind: 'any', allowMultiple: true },
        { type: 'media', id: 'file', label: 'File' }, // no mediaKind or allowMultiple
      ],
    })
    const meta = buildDataMeta([table])
    const fields = meta.tables[0].fields

    expect(fields.find((f) => f.id === 'photo')).toEqual({
      id: 'photo', label: 'Photo', type: 'media', mediaKind: 'image', allowMultiple: false,
    })
    expect(fields.find((f) => f.id === 'gallery')).toEqual({
      id: 'gallery', label: 'Gallery', type: 'media', mediaKind: 'any', allowMultiple: true,
    })
    expect(fields.find((f) => f.id === 'file')).toEqual({
      id: 'file', label: 'File', type: 'media',
    })
  })

  it('resolves relation targetTableId to targetTableSlug using sibling tables', () => {
    const authorTable = makeDataTable({
      id: 'table-authors',
      slug: 'authors',
      name: 'Authors',
    })
    const postTable = makePostTypeTable({
      fields: [
        { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
        {
          type: 'relation',
          id: 'author',
          label: 'Author',
          targetTableId: 'table-authors',
          allowMultiple: false,
        },
      ],
    })
    const meta = buildDataMeta([authorTable, postTable])
    const postMeta = meta.tables.find((t) => t.id === 'table-posts')
    const authorField = postMeta?.fields.find((f) => f.id === 'author')

    expect(authorField).toMatchObject({
      id: 'author',
      label: 'Author',
      type: 'relation',
      targetTableSlug: 'authors',
      allowMultiple: false,
    })
  })

  it('omits relation fields whose targetTableId is not in the table list', () => {
    const table = makePostTypeTable({
      fields: [
        { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
        {
          type: 'relation',
          id: 'missing',
          label: 'Missing relation',
          targetTableId: 'table-does-not-exist',
        },
      ],
    })
    const meta = buildDataMeta([table])
    const fields = meta.tables[0].fields

    expect(fields).toHaveLength(1) // only 'title'; 'missing' is omitted
    expect(fields.find((f) => f.id === 'missing')).toBeUndefined()
  })

  it('projects a repeater item schema with media and resolved relations', () => {
    const authorTable = makeDataTable({
      id: 'table-authors',
      slug: 'authors',
      name: 'Authors',
    })
    const projectTable = makePostTypeTable({
      fields: [{
        type: 'repeater',
        id: 'gallery',
        label: 'Project gallery',
        itemLabelFieldId: 'caption',
        fields: [
          { type: 'text', id: 'caption', label: 'Caption' },
          {
            type: 'media',
            id: 'images',
            label: 'Images',
            mediaKind: 'image',
            allowMultiple: true,
          },
          {
            type: 'relation',
            id: 'photographer',
            label: 'Photographer',
            targetTableId: 'table-authors',
          },
          {
            type: 'relation',
            id: 'missing',
            label: 'Missing',
            targetTableId: 'table-missing',
          },
        ],
      }],
    })

    const meta = buildDataMeta([authorTable, projectTable])
    const gallery = meta.tables
      .find((table) => table.id === projectTable.id)
      ?.fields.find((field) => field.id === 'gallery')

    expect(gallery).toEqual({
      id: 'gallery',
      label: 'Project gallery',
      type: 'repeater',
      itemLabelFieldId: 'caption',
      fields: [
        { id: 'caption', label: 'Caption', type: 'text' },
        {
          id: 'images',
          label: 'Images',
          type: 'media',
          mediaKind: 'image',
          allowMultiple: true,
        },
        {
          id: 'photographer',
          label: 'Photographer',
          type: 'relation',
          targetTableSlug: 'authors',
        },
      ],
    })
    expect(Value.Check(DataMetaSchema, meta)).toBe(true)
  })

  it('output validates against DataMetaSchema', () => {
    const authorTable = makeDataTable({
      id: 'table-authors',
      slug: 'authors',
      name: 'Authors',
    })
    const postTable = makePostTypeTable({
      fields: [
        { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
        { type: 'media', id: 'cover', label: 'Cover', mediaKind: 'image' },
        {
          type: 'relation',
          id: 'author',
          label: 'Author',
          targetTableId: 'table-authors',
          allowMultiple: false,
        },
      ],
    })
    const meta = buildDataMeta([authorTable, postTable])
    expect(Value.Check(DataMetaSchema, meta)).toBe(true)
  })
})
