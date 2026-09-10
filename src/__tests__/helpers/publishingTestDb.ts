/** Real repositories and migrations for publication tests; no SQL-text emulator. */
import { parsePage, type Page, type SiteDocument } from '@core/page-tree'
import { pageToCells } from '@core/data/pageFromRow'
import { visualComponentToCells } from '@core/data/componentFromRow'
import { createDataRow, getDataRow, saveDataRowDraft } from '../../../server/repositories/data'
import { saveDraftSite } from '../../../server/repositories/site'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { createTestDb, type TestDb } from './createTestDb'
import { makeSite } from '../publisher/helpers'

const cleanups: Array<() => Promise<void>> = []
export async function cleanupPublishingTestDbs(): Promise<void> {
  while (cleanups.length) await cleanups.pop()!()
}

export async function seedPublishingPage(db: TestDb['db'], page: Page): Promise<void> {
  const cells = pageToCells(parsePage(page))
  if (await getDataRow(db, page.id)) await saveDataRowDraft(db, page.id, { cells, slug: page.slug })
  else await createDataRow(db, { id: page.id, tableId: 'pages', cells, slug: page.slug })
}

export async function seedPublishingSite(db: TestDb['db'], site: SiteDocument): Promise<void> {
  await saveDraftSite(db, site)
  for (const page of site.pages) await seedPublishingPage(db, page)
  for (const component of site.visualComponents ?? []) {
    const cells = visualComponentToCells(component)
    await createDataRow(db, { id: component.id, tableId: 'components', cells, slug: component.name })
  }
}

export async function createPublishingTestDb(site?: SiteDocument | null, publish = true): Promise<TestDb['db']> {
  const { db, cleanup } = await createTestDb()
  cleanups.push(cleanup)
  if (site) {
    await seedPublishingSite(db, { ...makeSite({ layouts: [] }), ...site })
    if (publish) await publishDraftSite(db, null, undefined, {
      variants: site.pages.map((page) => ({ rowId: page.id, localeId: 'default' })),
    })
  }
  return db
}
