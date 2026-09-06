/**
 * Which pages use a file — worked out from the site, not from a stored index.
 *
 * The avatar case could be RECORDED because a profile picture has one writer
 * and an explicit set/unset. Page content has neither: it is written
 * continuously by the collab relay, and deleting an image emits no event at
 * all — so a table would slowly fill with references to nodes that no longer
 * exist, and the delete warning would start naming pages that are fine.
 *
 * That is the failure worth testing against, because a warning that is
 * sometimes wrong is worse than no warning: it gets ignored. Everything here
 * pins the property that makes it impossible — the answer comes from the
 * current document, so it cannot describe a state the document is not in.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import type { SiteShell } from '@core/page-tree'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { createTestDb } from '../helpers/createTestDb'
import { saveDraftSite } from '../../../server/repositories/site'
import { createDataRow, saveDataRowDraft } from '../../../server/repositories/data'
import { pageToCells } from '../../../src/core/data/pageFromRow'
import { collectContentUsageRefs } from '../../../server/media/contentUsage'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const HERO_PATH = '/uploads/hero.png'

function siteShell(overrides: Partial<SiteShell> = {}): SiteShell {
  return {
    id: 'project_1',
    name: 'Site',
    files: [],
    visualComponents: [],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: { shortcuts: {} },
    styleRules: {},
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: normalizeSiteRuntimeConfig(undefined),
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  }
}

/** A page whose single image node points at `src`, or none when null. */
function pageWith(id: string, title: string, slug: string, src: string | null) {
  const nodes: Record<string, unknown> = {
    root: {
      id: 'root',
      moduleId: 'base.body',
      props: {},
      breakpointOverrides: {},
      children: src === null ? [] : ['img_1'],
      classIds: [],
    },
  }
  if (src !== null) {
    nodes['img_1'] = {
      id: 'img_1',
      moduleId: 'base.image',
      props: { src },
      breakpointOverrides: {},
      children: [],
      classIds: [],
    }
  }
  return { id, title, slug, rootNodeId: 'root', nodes }
}

async function freshDb() {
  const { db, cleanup } = await createTestDb()
  cleanups.push(cleanup)
  // `data_rows.created_by` is a foreign key into `users`.
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, status, role_id)
    values ('admin_1', 'ada@example.com', 'ada@example.com', 'Ada', 'hash', 'active', 'owner')
  `
  await db`
    insert into media_assets (id, filename, mime_type, size_bytes, storage_path, public_path)
    values ('a1', 'hero.png', 'image/png', 10, '/s/a1', ${HERO_PATH})
  `
  await db`
    insert into media_assets (id, filename, mime_type, size_bytes, storage_path, public_path)
    values ('a2', 'unused.png', 'image/png', 10, '/s/a2', '/uploads/unused.png')
  `
  return db
}

async function seedPage(
  db: Awaited<ReturnType<typeof freshDb>>,
  page: ReturnType<typeof pageWith>,
) {
  await createDataRow(db, {
    id: page.id,
    tableId: 'pages',
    cells: pageToCells(page as never),
    slug: page.slug,
  }, 'admin_1')
}

describe('media used by page content', () => {
  it('names the page an image sits on', async () => {
    const db = await freshDb()
    await saveDraftSite(db, siteShell())
    await seedPage(db, pageWith('page_home', 'Home', 'index', HERO_PATH))

    const refs = await collectContentUsageRefs(db, ['a1'])
    expect(refs).toHaveLength(1)
    expect(refs[0]!.refKind).toBe('page.content')
    expect(refs[0]!.label).toBe('Home')
    expect(refs[0]!.assetId).toBe('a1')
  })

  it('reports nothing for a file no page references', async () => {
    const db = await freshDb()
    await saveDraftSite(db, siteShell())
    await seedPage(db, pageWith('page_home', 'Home', 'index', HERO_PATH))

    expect(await collectContentUsageRefs(db, ['a2'])).toEqual([])
  })

  it('names every page, because every one of them breaks', async () => {
    const db = await freshDb()
    await saveDraftSite(db, siteShell())
    await seedPage(db, pageWith('page_home', 'Home', 'index', HERO_PATH))
    await seedPage(db, pageWith('page_about', 'About us', 'about', HERO_PATH))

    const labels = (await collectContentUsageRefs(db, ['a1'])).map((r) => r.label)
    expect(labels.sort()).toEqual(['About us', 'Home'])
  })

  it('stops reporting as soon as the image is taken off the page', async () => {
    // The whole reason this is computed rather than recorded. Removing an
    // image emits no event a table could listen for, so a stored reference
    // would still be pointing at this page — and the warning would send the
    // operator to fix something that is already fine.
    const db = await freshDb()
    await saveDraftSite(db, siteShell())
    await seedPage(db, pageWith('page_home', 'Home', 'index', HERO_PATH))
    expect(await collectContentUsageRefs(db, ['a1'])).toHaveLength(1)

    await saveDataRowDraft(db, 'page_home', {
      cells: pageToCells(pageWith('page_home', 'Home', 'index', null) as never),
      slug: 'index',
    }, 'admin_1')

    expect(await collectContentUsageRefs(db, ['a1'])).toEqual([])
  })

  it('sees a draft page, not just what has been published', async () => {
    // An image on an unpublished page is still in use: deleting it would
    // break the page the moment it goes live. Reading published artefacts
    // instead of the draft document would have missed exactly this.
    const db = await freshDb()
    await saveDraftSite(db, siteShell())
    await seedPage(db, pageWith('page_draft', 'Not yet live', 'soon', HERO_PATH))

    const refs = await collectContentUsageRefs(db, ['a1'])
    expect(refs).toHaveLength(1)
    expect(refs[0]!.label).toBe('Not yet live')
  })

  it('answers for a whole selection in one call', async () => {
    const db = await freshDb()
    await saveDraftSite(db, siteShell())
    await seedPage(db, pageWith('page_home', 'Home', 'index', HERO_PATH))

    const refs = await collectContentUsageRefs(db, ['a1', 'a2'])
    expect(refs.map((r) => r.assetId)).toEqual(['a1'])
  })

  it('returns nothing for an empty selection without loading the site', async () => {
    const db = await freshDb()
    expect(await collectContentUsageRefs(db, [])).toEqual([])
  })

  it('reports nothing when there is no site document yet', async () => {
    const db = await freshDb()
    expect(await collectContentUsageRefs(db, ['a1'])).toEqual([])
  })
})
