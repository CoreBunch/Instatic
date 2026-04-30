import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '../../core/editor-store/store'
import { normalizeProjectDataModel, slugifyTableName, validateProjectDataModel } from '../../core/data-model/validation'

beforeEach(() => {
  useEditorStore.setState({
    project: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    hoveredNodeId: null,
    hasUnsavedChanges: false,
  })
})

describe('data model validation', () => {
  it('creates Convex-safe table slugs from user-facing names', () => {
    expect(slugifyTableName('2026 Posts')).toBe('table_2026_posts')
    expect(slugifyTableName('Blog Posts')).toBe('blog_posts')
  })

  it('normalizes duplicate tables, fields, indexes, and permissions', () => {
    const data = normalizeProjectDataModel({
      tables: [
        {
          id: 'posts',
          name: 'Posts',
          slug: 'posts',
          fields: [
            { id: 'title', name: 'Post title', type: 'string', required: true },
            { id: 'duplicate', name: 'Post title', type: 'number' },
          ],
          indexes: [
            { id: 'by_title', name: '', fields: ['Post_title'] },
            { id: 'invalid', fields: ['missing'] },
          ],
          permissions: { read: 'invalid', create: 'public', update: 'authenticated', delete: 'invalid' },
        },
        {
          id: 'posts_two',
          name: 'Posts',
          slug: 'posts',
          fields: [],
        },
      ],
    })

    expect(data.tables.map((table) => table.slug)).toEqual(['posts', 'posts_2'])
    expect(data.tables[0].fields.map((field) => field.name)).toEqual(['Post_title'])
    expect(data.tables[0].indexes).toEqual([{ id: 'by_title', name: 'by_Post_title', fields: ['Post_title'] }])
    expect(data.tables[0].permissions).toEqual({
      read: 'public',
      create: 'public',
      update: 'authenticated',
      delete: 'owner',
    })
    expect(validateProjectDataModel(data)).toEqual([])
  })

  it('reports broken relation targets', () => {
    const data = normalizeProjectDataModel({
      tables: [
        {
          id: 'posts',
          name: 'Posts',
          fields: [
            { id: 'author', name: 'authorId', type: 'relation', relation: { tableId: 'missing', cardinality: 'one' } },
          ],
        },
      ],
    })

    expect(validateProjectDataModel(data)).toContainEqual({
      path: 'data.tables[0].fields[0].relation',
      message: 'Relation target table is missing.',
    })
  })
})

describe('data model store slice', () => {
  it('keeps indexes and seed records in sync when a field is renamed', () => {
    const store = useEditorStore.getState()
    store.createProject('Data Test')
    const table = useEditorStore.getState().createDataTable('Posts')
    const title = useEditorStore.getState().addDataField(table.id, { name: 'title', type: 'string' })
    useEditorStore.getState().addDataIndex(table.id, [title.name])
    useEditorStore.getState().addDataSeedRecord(table.id, { title: 'Hello' })

    useEditorStore.getState().updateDataField(table.id, title.id, { name: 'headline' })

    const updated = useEditorStore.getState().project!.data.tables[0]
    expect(updated.fields[0].name).toBe('headline')
    expect(updated.indexes[0]).toEqual({ id: updated.indexes[0].id, name: 'by_headline', fields: ['headline'] })
    expect(updated.seedRecords[0].values).toEqual({ headline: 'Hello' })
  })
})
