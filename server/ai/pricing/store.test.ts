import { describe, expect, it } from 'bun:test'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import type { DbClient } from '../../db/client'
import { loadCachedCatalogue, saveCachedCatalogue } from './store'
import type { ModelCatalogue } from './openrouterCatalogue'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  return db
}

function catalogueOf(size: number): ModelCatalogue {
  const catalogue: ModelCatalogue = new Map()
  for (let i = 0; i < size; i++) {
    catalogue.set(`vendor/model-${i}`, {
      prices: {
        inputPerMTok: i + 0.5,
        outputPerMTok: i + 1.5,
        // Alternate the nullable columns so the placeholder offsets are
        // exercised with both real values and nulls in the same statement.
        cacheReadPerMTok: i % 2 === 0 ? i + 0.25 : null,
        cacheWritePerMTok: i % 2 === 0 ? null : i + 0.75,
      },
      contextWindow: i % 3 === 0 ? null : 1000 + i,
    })
  }
  return catalogue
}

describe('saveCachedCatalogue', () => {
  it('round-trips an empty catalogue', async () => {
    const db = await freshDb()
    await saveCachedCatalogue(db, new Map())
    expect(await loadCachedCatalogue(db)).toBeNull()
    await db.close()
  })

  // 250 rows spans two chunks (PRICING_INSERT_CHUNK = 200), which is what
  // makes the per-tuple placeholder arithmetic worth a test at all.
  it.each([1, 250])('round-trips %i rows across the chunked insert', async (size) => {
    const db = await freshDb()
    const expected = catalogueOf(size)
    await saveCachedCatalogue(db, expected)

    const loaded = await loadCachedCatalogue(db)
    expect(loaded).not.toBeNull()
    expect(loaded!.size).toBe(size)
    for (const [key, entry] of expected) {
      expect(loaded!.get(key)).toEqual(entry)
    }
    await db.close()
  })

  it('replaces the previous catalogue wholesale', async () => {
    const db = await freshDb()
    await saveCachedCatalogue(db, catalogueOf(5))
    await saveCachedCatalogue(db, catalogueOf(2))

    const loaded = await loadCachedCatalogue(db)
    expect(loaded!.size).toBe(2)
    expect(loaded!.has('vendor/model-4')).toBe(false)
    await db.close()
  })
})
