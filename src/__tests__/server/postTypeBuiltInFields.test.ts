/**
 * postTypeBuiltInFields.test.ts — a post type must be routable no matter which
 * caller created it.
 *
 * The Content UI seeds `title`/`slug` client-side. A table created through the
 * data API, an MCP connector, or an import used to arrive without them, and
 * `slugForTable` returns an empty slug for a table with no `slug` field — so
 * every entry in that post type was published with no public route.
 *
 * The same hole existed on UPDATE, where it is worse: `fields` is a
 * whole-list replacement, so adding one custom field by PATCHing the custom
 * field list silently deleted every built-in. The table saved, the rows kept
 * their `slug` cell, and the next save of any row recomputed the routable
 * slug as '' — turning live entry routes into redirects with no error
 * anywhere.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteClient } from '../../../server/db/sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import type { DbClient } from '../../../server/db/client'
import { createDataTable, getDataTable, updateDataTable } from '../../../server/repositories/data'
import { insertDataTableIfAbsent } from '../../../server/repositories/data/tables'
import { slugForTable } from '@core/data/cells'
import { buildPostTypeDefaultFields } from '@core/data/fields'
import {
  POST_TYPE_MANDATORY_FIELD_IDS,
  POST_TYPE_OPTIONAL_BUILTIN_FIELD_IDS,
} from '@core/data/schemas'
import { MAIN_SCOPE } from '../../../server/branches/scope'

async function setupDb(): Promise<{ db: DbClient; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'instatic-posttype-'))
  const db = createSqliteClient(join(dir, 'test.db'))
  await runMigrations(db, sqliteMigrations)
  return {
    db,
    cleanup: async () => {
      await db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('createDataTable — post-type built-in fields', () => {
  it('seeds the built-in fields when a post type ships only custom ones', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await createDataTable(db, MAIN_SCOPE, {
        name: 'Recipes',
        slug: 'recipes',
        kind: 'postType',
        routeBase: '/recipes',
        singularLabel: 'Recipe',
        pluralLabel: 'Recipes',
        fields: [{ type: 'text', id: 'crop', label: 'Crop' }],
      })

      const ids = table.fields.map((field) => field.id)
      for (const required of POST_TYPE_MANDATORY_FIELD_IDS) {
        expect(ids).toContain(required)
      }
      expect(ids).toContain('crop')
      // Built-ins lead so the Content editor renders them in canonical order.
      expect(ids.indexOf('title')).toBeLessThan(ids.indexOf('crop'))
    } finally {
      await cleanup()
    }
  })

  it('respects removal of the optional built-ins, matching the PATCH rule', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const supplied = buildPostTypeDefaultFields().filter(
        (field) => !['featuredMedia', 'seoTitle', 'seoDescription'].includes(field.id),
      )
      const table = await createDataTable(db, MAIN_SCOPE, {
        name: 'Catalog',
        slug: 'catalog',
        kind: 'postType',
        routeBase: '/catalog',
        singularLabel: 'Product',
        pluralLabel: 'Catalog',
        fields: supplied,
      })

      const ids = table.fields.map((field) => field.id)
      expect(ids).not.toContain('featuredMedia')
      expect(ids).not.toContain('seoTitle')
      expect(ids).not.toContain('seoDescription')
      for (const required of POST_TYPE_MANDATORY_FIELD_IDS) {
        expect(ids).toContain(required)
      }
    } finally {
      await cleanup()
    }
  })

  it('seeds the full canonical set when no fields are supplied at all', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await createDataTable(db, MAIN_SCOPE, {
        name: 'Notes',
        slug: 'notes',
        kind: 'postType',
        routeBase: '/notes',
        singularLabel: 'Note',
        pluralLabel: 'Notes',
        fields: [],
      })

      const canonicalIds = buildPostTypeDefaultFields().map((field) => field.id)
      expect(table.fields.map((field) => field.id)).toEqual(canonicalIds)
    } finally {
      await cleanup()
    }
  })

  it('makes entries in such a table routable', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await createDataTable(db, MAIN_SCOPE, {
        name: 'Recipes',
        slug: 'recipes',
        kind: 'postType',
        singularLabel: 'Recipe',
        pluralLabel: 'Recipes',
        fields: [{ type: 'text', id: 'crop', label: 'Crop' }],
      })
      // The published route is derived from this; '' means no public page.
      expect(slugForTable(table, { title: 'Tomato Interlight 12', slug: 'tomato-interlight-12' })).toBe(
        'tomato-interlight-12',
      )
    } finally {
      await cleanup()
    }
  })

  it('does not override a caller-supplied built-in field', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await createDataTable(db, MAIN_SCOPE, {
        name: 'Recipes',
        slug: 'recipes',
        kind: 'postType',
        singularLabel: 'Recipe',
        pluralLabel: 'Recipes',
        fields: [{ type: 'text', id: 'title', label: 'Recipe name' }],
      })
      const title = table.fields.filter((field) => field.id === 'title')
      expect(title).toHaveLength(1)
      expect(title[0]!.label).toBe('Recipe name')
    } finally {
      await cleanup()
    }
  })

  it('seeds the built-in fields on the import path too', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const inserted = await insertDataTableIfAbsent(db, MAIN_SCOPE, {
        id: 'tbl-imported',
        name: 'Recipes',
        slug: 'recipes',
        kind: 'postType',
        routeBase: '/recipes',
        singularLabel: 'Recipe',
        pluralLabel: 'Recipes',
        fields: [{ type: 'text', id: 'crop', label: 'Crop' }],
      })
      expect(inserted).toBe(true)
      const table = await getDataTable(db, MAIN_SCOPE, 'tbl-imported')
      expect(table!.fields.map((field) => field.id)).toContain('slug')
      expect(slugForTable(table!, { slug: 'tomato' })).toBe('tomato')
    } finally {
      await cleanup()
    }
  })

  it('leaves ordinary data tables untouched', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await createDataTable(db, MAIN_SCOPE, {
        name: 'Chambers',
        slug: 'chambers',
        kind: 'data',
        singularLabel: 'Chamber',
        pluralLabel: 'Chambers',
        fields: [{ type: 'text', id: 'chamberCode', label: 'Chamber' }],
      })
      expect(table.fields.map((field) => field.id)).toEqual(['chamberCode'])
      // A reusable table is deliberately non-routable.
      expect(slugForTable(table, { chamberCode: 'K1' })).toBe('')
    } finally {
      await cleanup()
    }
  })
})

describe('updateDataTable — post-type built-in fields survive a PATCH', () => {
  /** Create the shape the bug needs: a post type with built-ins plus customs. */
  async function seedRecipes(db: DbClient) {
    return createDataTable(db, MAIN_SCOPE, {
      name: 'Recipes',
      slug: 'recipes',
      kind: 'postType',
      routeBase: '/recipes',
      singularLabel: 'Recipe',
      pluralLabel: 'Recipes',
      fields: [{ type: 'text', id: 'crop', label: 'Crop' }],
    })
  }

  it('keeps the built-ins when a patch sends only the custom fields', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await seedRecipes(db)
      // Adding one custom field. This is the natural payload, and it used to
      // delete every built-in, `slug` included.
      const updated = await updateDataTable(db, MAIN_SCOPE, table.id, {
        fields: [
          { type: 'text', id: 'crop', label: 'Crop' },
          { type: 'text', id: 'yield', label: 'Yield' },
        ],
      })

      const ids = updated!.fields.map((field) => field.id)
      for (const required of POST_TYPE_MANDATORY_FIELD_IDS) {
        expect(ids).toContain(required)
      }
      expect(ids).toContain('crop')
      expect(ids).toContain('yield')
    } finally {
      await cleanup()
    }
  })

  it('leaves entries routable after such a patch', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await seedRecipes(db)
      const updated = await updateDataTable(db, MAIN_SCOPE, table.id, {
        fields: [{ type: 'text', id: 'crop', label: 'Crop' }],
      })
      // The actual damage: with no `slug` field this returns '', and every
      // published entry in the post type loses its public route on next save.
      expect(slugForTable(updated!, { title: 'Tomato', slug: 'tomato' })).toBe('tomato')
    } finally {
      await cleanup()
    }
  })

  it('preserves a customised built-in rather than reseeding the default', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await createDataTable(db, MAIN_SCOPE, {
        name: 'Recipes',
        slug: 'recipes',
        kind: 'postType',
        singularLabel: 'Recipe',
        pluralLabel: 'Recipes',
        fields: [{ type: 'text', id: 'title', label: 'Recipe name' }],
      })
      const updated = await updateDataTable(db, MAIN_SCOPE, table.id, {
        fields: [{ type: 'text', id: 'crop', label: 'Crop' }],
      })
      const title = updated!.fields.filter((field) => field.id === 'title')
      expect(title).toHaveLength(1)
      expect(title[0]!.label).toBe('Recipe name')
    } finally {
      await cleanup()
    }
  })

  it('still lets a patch relabel a built-in it does send', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await seedRecipes(db)
      const updated = await updateDataTable(db, MAIN_SCOPE, table.id, {
        fields: [
          { type: 'text', id: 'slug', label: 'Web address', required: true, builtIn: true },
          { type: 'text', id: 'crop', label: 'Crop' },
        ],
      })
      const slug = updated!.fields.filter((field) => field.id === 'slug')
      expect(slug).toHaveLength(1)
      expect(slug[0]!.label).toBe('Web address')
    } finally {
      await cleanup()
    }
  })

  it('restores title/slug on a table an earlier patch already stripped', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await seedRecipes(db)
      // Simulate the damage this bug shipped: a table already missing them.
      await db`update data_tables set fields_json = ${[{ type: 'text', id: 'crop', label: 'Crop' }]} where id = ${table.id}`
      const damaged = await getDataTable(db, MAIN_SCOPE, table.id)
      expect(damaged!.fields.map((field) => field.id)).not.toContain('slug')

      const repaired = await updateDataTable(db, MAIN_SCOPE, table.id, {
        fields: [{ type: 'text', id: 'crop', label: 'Crop' }],
      })
      for (const required of POST_TYPE_MANDATORY_FIELD_IDS) {
        expect(repaired!.fields.map((field) => field.id)).toContain(required)
      }
      expect(slugForTable(repaired!, { slug: 'tomato' })).toBe('tomato')
    } finally {
      await cleanup()
    }
  })

  it('lets a patch drop an OPTIONAL built-in, which the Data inspector offers back', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await seedRecipes(db)
      const updated = await updateDataTable(db, MAIN_SCOPE, table.id, {
        fields: [{ type: 'text', id: 'crop', label: 'Crop' }],
      })
      const ids = updated!.fields.map((field) => field.id)
      for (const optional of POST_TYPE_OPTIONAL_BUILTIN_FIELD_IDS) {
        expect(ids).not.toContain(optional)
      }
    } finally {
      await cleanup()
    }
  })

  it('lets a patch drop a CUSTOM field', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await seedRecipes(db)
      const updated = await updateDataTable(db, MAIN_SCOPE, table.id, { fields: [] })
      expect(updated!.fields.map((field) => field.id)).not.toContain('crop')
      expect(updated!.fields.map((field) => field.id)).toContain('slug')
    } finally {
      await cleanup()
    }
  })

  it('does not touch the fields of an ordinary data table', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await createDataTable(db, MAIN_SCOPE, {
        name: 'Chambers',
        slug: 'chambers',
        kind: 'data',
        singularLabel: 'Chamber',
        pluralLabel: 'Chambers',
        fields: [{ type: 'text', id: 'chamberCode', label: 'Chamber' }],
      })
      const updated = await updateDataTable(db, MAIN_SCOPE, table.id, {
        fields: [{ type: 'text', id: 'rack', label: 'Rack' }],
      })
      expect(updated!.fields.map((field) => field.id)).toEqual(['rack'])
    } finally {
      await cleanup()
    }
  })
})
