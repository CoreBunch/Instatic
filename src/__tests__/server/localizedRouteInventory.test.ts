import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient } from '../../../server/db/client'
import { createTestDb } from '../helpers/createTestDb'
import { createLocale } from '../../../server/repositories/localization'
import { loadPublishedRouteInventory } from '../../../server/publish/publishedRoutes'
import { findPublishedContentRoute, resolvePublishedRoute } from '@core/localization-routing'

let db: DbClient
let cleanup: () => Promise<void>
let secondaryLocaleId: string

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb())
  const locale = await createLocale(db, { code: 'fr', name: 'Français', pathPrefix: 'fr', enabled: true, direction: 'ltr' })
  secondaryLocaleId = locale.id
})

afterEach(async () => {
  await cleanup()
})

async function publishFixture(options: {
  rowId: string
  localeId: string
  path: string | null
  tableId?: string
  availability?: 'online' | 'offline'
}): Promise<string> {
  const versionId = crypto.randomUUID()
  const tableId = options.tableId ?? 'pages'
  await db`
    insert into data_rows (id, table_id, slug, cells_json)
    values (${options.rowId}, ${tableId}, ${options.rowId}, ${{ title: 'Draft title' }})
    on conflict (id) do nothing
  `
  const { rows } = await db<{ next: number }>`
    select coalesce(max(version_number), 0) + 1 as next from data_row_versions where row_id = ${options.rowId}
  `
  await db`
    insert into data_row_versions (id, row_id, locale_id, version_number, public_path, slug, cells_json)
    values (${versionId}, ${options.rowId}, ${options.localeId}, ${Number(rows[0].next)}, ${options.path}, ${'live-slug'}, ${{ title: 'Live title' }})
  `
  await db`
    insert into data_row_localizations (row_id, locale_id, slug, availability, active_version_id)
    values (${options.rowId}, ${options.localeId}, ${'draft-slug'}, ${options.availability ?? 'online'}, ${versionId})
    on conflict (row_id, locale_id) do update
      set active_version_id = excluded.active_version_id, availability = excluded.availability
  `
  return versionId
}

describe('DB-backed published locale inventory', () => {
  it('independently exposes the secondary version of an otherwise draft logical row', async () => {
    await publishFixture({ rowId: 'about', localeId: 'default', path: '/about', availability: 'offline' })
    const versionId = await publishFixture({ rowId: 'about', localeId: secondaryLocaleId, path: '/fr/a-propos' })
    const inventory = await loadPublishedRouteInventory(db)
    expect(resolvePublishedRoute(inventory, '/about')).toBeNull()
    expect(resolvePublishedRoute(inventory, '/fr/a-propos')?.publishedVersionId).toBe(versionId)
    expect(findPublishedContentRoute(inventory, 'about', 'default')).toBeNull()
  })

  it('uses frozen version paths after draft slug, language prefix and collection base edits', async () => {
    await publishFixture({ rowId: 'story', tableId: 'posts', localeId: secondaryLocaleId, path: '/fr/posts/original' })
    await db`update site_locales set path_prefix = ${'francais'} where id = ${secondaryLocaleId}`
    await db`update data_row_localizations set slug = ${'nouveau'} where row_id = ${'story'} and locale_id = ${secondaryLocaleId}`
    await db`
      insert into data_table_localizations (table_id, locale_id, route_base)
      values (${'posts'}, ${secondaryLocaleId}, ${'/actualites'})
    `
    const inventory = await loadPublishedRouteInventory(db)
    expect(inventory.routes.map((route) => route.path)).toEqual(['/fr/posts/original'])
    expect(resolvePublishedRoute(inventory, '/francais/actualites/nouveau')).toBeNull()
  })

  it('removes a disabled locale and keeps other locales of the same content live', async () => {
    await publishFixture({ rowId: 'about', localeId: 'default', path: '/about' })
    await publishFixture({ rowId: 'about', localeId: secondaryLocaleId, path: '/fr/a-propos' })
    await db`update site_locales set enabled = ${false} where id = ${secondaryLocaleId}`
    const inventory = await loadPublishedRouteInventory(db)
    expect(inventory.routes.map((route) => route.path)).toEqual(['/about'])
  })

  it('excludes deleted logical rows and deleted collections', async () => {
    await publishFixture({ rowId: 'deleted-page', localeId: 'default', path: '/deleted-page' })
    await publishFixture({ rowId: 'deleted-collection-item', tableId: 'posts', localeId: 'default', path: '/posts/item' })
    await db`update data_rows set deleted_at = current_timestamp where id = ${'deleted-page'}`
    await db`update data_tables set deleted_at = current_timestamp where id = ${'posts'}`
    expect((await loadPublishedRouteInventory(db)).routes).toEqual([])
  })

  it('does not expose a selected version from another language', async () => {
    const defaultVersion = await publishFixture({ rowId: 'about', localeId: 'default', path: '/about' })
    await publishFixture({ rowId: 'about', localeId: secondaryLocaleId, path: '/fr/a-propos' })
    await db`
      update data_row_localizations set active_version_id = ${defaultVersion}
      where row_id = ${'about'} and locale_id = ${secondaryLocaleId}
    `
    const inventory = await loadPublishedRouteInventory(db)
    expect(inventory.routes.map((route) => route.path)).toEqual(['/about'])
  })

  it('does not expose a selected version from another logical content item', async () => {
    const firstVersion = await publishFixture({ rowId: 'first', localeId: 'default', path: '/first' })
    await publishFixture({ rowId: 'second', localeId: 'default', path: '/second' })
    await db`update data_row_localizations set active_version_id = ${firstVersion} where row_id = ${'second'}`
    const inventory = await loadPublishedRouteInventory(db)
    expect(inventory.routes.map((route) => route.path)).toEqual(['/first'])
  })

  it('separates template dependencies from publicly addressable page and item routes', async () => {
    await publishFixture({ rowId: 'layout', localeId: 'default', path: null })
    await publishFixture({ rowId: 'unrouted-item', tableId: 'posts', localeId: 'default', path: null })
    const inventory = await loadPublishedRouteInventory(db)
    expect(inventory.routes).toEqual([])
    expect(inventory.dependencies.map((dependency) => dependency.contentId)).toEqual(['layout'])
  })
})
