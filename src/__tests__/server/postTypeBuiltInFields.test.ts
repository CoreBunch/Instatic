/**
 * postTypeBuiltInFields.test.ts — a post type must be routable no matter which
 * caller created it.
 *
 * The Content UI seeds `title`/`slug` client-side. A table created through the
 * data API, an MCP connector, or an import used to arrive without them, and
 * `slugForTable` returns an empty slug for a table with no `slug` field — so
 * every entry in that post type was published with no public route.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteClient } from '../../../server/db/sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import type { DbClient } from '../../../server/db/client'
import { createDataTable } from '../../../server/repositories/data'
import { slugForTable } from '@core/data/cells'
import { POST_TYPE_MANDATORY_FIELD_IDS } from '@core/data/schemas'

async function setupDb(): Promise<{ db: DbClient; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'instatic-posttype-'))
  const db = createSqliteClient(join(dir, 'test.db'))
  await runMigrations(db, sqliteMigrations)
  return { db, cleanup: async () => { await rm(dir, { recursive: true, force: true }) } }
}

describe('createDataTable — post-type built-in fields', () => {
  it('seeds the built-in fields when a post type ships only custom ones', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await createDataTable(db, {
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

  it('makes entries in such a table routable', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await createDataTable(db, {
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
      const table = await createDataTable(db, {
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

  it('leaves ordinary data tables untouched', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const table = await createDataTable(db, {
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
