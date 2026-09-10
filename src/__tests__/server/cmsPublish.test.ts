import { afterEach, describe, expect, it } from 'bun:test'
import type { SiteShell } from '@core/page-tree'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { saveDraftSite } from '../../../server/repositories/site'
import {
  getDraftPublishStatus,
  getPublishedPageBySlug,
} from '../../../server/repositories/publish'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { createDataRow, saveDataRowDraft } from '../../../server/repositories/data'
import { pageToCells } from '../../../src/core/data/pageFromRow'
import { cleanupPublishingTestDbs, createPublishingTestDb } from '../helpers/publishingTestDb'
import type { DbClient } from '../../../server/db'
afterEach(cleanupPublishingTestDbs)

function makeSiteShell(overrides: Partial<SiteShell> = {}): SiteShell {
  return {
    id: 'project_1',
    name: 'Published Site',
    files: overrides.files ?? [],
    visualComponents: [],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: { shortcuts: {} },
    styleRules: {},
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: normalizeSiteRuntimeConfig(overrides.runtime),
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  }
}

function makeHomePage(text: string) {
  return {
    id: 'page_home',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.body',
        props: {},
        breakpointOverrides: {},
        children: ['text_1'],
        classIds: [],
      },
      text_1: {
        id: 'text_1',
        moduleId: 'base.text',
        props: { text, tag: 'h1' },
        breakpointOverrides: {},
        children: [],
        classIds: [],
      },
    },
  }
}

async function seedSiteAndPage(
  db: DbClient,
  text: string,
) {
  const shell = makeSiteShell()
  await saveDraftSite(db, shell)
  const page = makeHomePage(text)
  await createDataRow(db, {
    id: page.id,
    tableId: 'pages',
    cells: pageToCells(page),
    slug: page.slug,
  }, null)
}

describe('CMS publishing', () => {
  it('publishes draft pages as immutable active snapshots', async () => {
    const db = await createPublishingTestDb()
    await seedSiteAndPage(db, 'Published headline')

    const result = await publishDraftSite(db, null, undefined, { variants: [{ rowId: 'page_home', localeId: 'default' }] })
    const published = await getPublishedPageBySlug(db, 'index')

    expect(result).toMatchObject({ publishedPages: 1 })
    expect((await db`select id from data_row_versions`).rows).toHaveLength(1)
    expect(published?.site.pages[0].nodes.text_1.props.text).toBe('Published headline')
  })

  it('does not expose later draft changes until another publish occurs', async () => {
    const db = await createPublishingTestDb()
    await seedSiteAndPage(db, 'Public version')
    await publishDraftSite(db, null, undefined, { variants: [{ rowId: 'page_home', localeId: 'default' }] })

    // Update the draft page text
    await saveDataRowDraft(db, 'page_home', {
      cells: pageToCells({ ...makeHomePage('Draft only') }),
      slug: 'index',
    }, null)
    const published = await getPublishedPageBySlug(db, 'index')

    expect(published?.site.pages[0].nodes.text_1.props.text).toBe('Public version')
  })

  it('reports that the current draft matches the active published snapshots after publishing', async () => {
    const db = await createPublishingTestDb()
    await seedSiteAndPage(db, 'Public version')
    await publishDraftSite(db, null, undefined, { variants: [{ rowId: 'page_home', localeId: 'default' }] })

    const status = await getDraftPublishStatus(db)

    expect(status).toMatchObject({
      hasPublishedVersion: true,
      draftMatchesPublished: true,
      draftPages: 1,
      publishedPages: 1,
    })
    expect(status.lastPublishedAt).toBeTruthy()
  })

  it('keeps publish status matched when publishing changes the rows recency order', async () => {
    const db = await createPublishingTestDb()
    const shell = makeSiteShell()
    await saveDraftSite(db, shell)

    const home = makeHomePage('Home')
    const layout = {
      ...makeHomePage('Layout'),
      id: 'page_layout',
      title: 'Main layout',
      slug: 'main-layout',
      template: {
        enabled: true as const,
        target: { kind: 'everywhere' as const },
        priority: 0,
      },
    }
    for (const page of [home, layout]) {
      await createDataRow(db, {
        id: page.id,
        tableId: 'pages',
        cells: pageToCells(page),
        slug: page.slug,
      }, null)
    }

    await db`update data_rows set created_at = ${'2026-01-01T00:00:00Z'}, updated_at = ${'2026-01-02T00:00:00Z'} where id = ${home.id}`
    await db`update data_rows set created_at = ${'2026-01-02T00:00:00Z'}, updated_at = ${'2026-01-01T00:00:00Z'} where id = ${layout.id}`

    await publishDraftSite(db, null, undefined, { variants: [{ rowId: 'page_home', localeId: 'default' }] })
    const status = await getDraftPublishStatus(db)

    expect(status).toMatchObject({
      hasPublishedVersion: true,
      draftMatchesPublished: true,
      draftPages: 1,
      publishedPages: 1,
    })
  })

  it('reports that the current draft no longer matches after a later draft save', async () => {
    const db = await createPublishingTestDb()
    await seedSiteAndPage(db, 'Public version')
    await publishDraftSite(db, null, undefined, { variants: [{ rowId: 'page_home', localeId: 'default' }] })

    // Update the draft to create mismatch
    await saveDataRowDraft(db, 'page_home', {
      cells: pageToCells({ ...makeHomePage('Draft only') }),
      slug: 'index',
    }, null)

    const status = await getDraftPublishStatus(db)

    expect(status).toMatchObject({
      hasPublishedVersion: true,
      draftMatchesPublished: false,
      draftPages: 1,
      publishedPages: 1,
    })
  })

  it('stores built runtime assets with the published page version', async () => {
    const db = await createPublishingTestDb()
    const shell = makeSiteShell({
      files: [
        {
          id: 'entry',
          path: 'src/scripts/entry.ts',
          type: 'script',
          content: `window.__publishedRuntime = 'ok'`,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      runtime: normalizeSiteRuntimeConfig({
        scripts: {
          entry: {
            placement: 'body-end',
            priority: 10,
          },
        },
      }),
    })
    await saveDraftSite(db, shell)
    const page = makeHomePage('Runtime page')
    await createDataRow(db, {
      id: page.id,
      tableId: 'pages',
      cells: pageToCells(page),
      slug: page.slug,
    }, null)

    await publishDraftSite(db, null, undefined, { variants: [{ rowId: 'page_home', localeId: 'default' }] })
    const published = await getPublishedPageBySlug(db, 'index')

    const { rows: runtimeAssets } = await db<{ public_path: string }>`select public_path from published_runtime_assets`
    expect(runtimeAssets.length).toBeGreaterThan(0)
    expect(String(runtimeAssets[0].public_path)).toContain('/_instatic/assets/')
    expect(published?.runtimeAssets?.scripts).toHaveLength(1)
    expect(published?.runtimeAssets?.scripts[0].src).toBe(runtimeAssets[0].public_path)
  })

  it('rejects invalid authored runtime scripts with their file and location before writing a publish', async () => {
    const db = await createPublishingTestDb()
    const shell = makeSiteShell({
      files: [
        {
          id: 'forgotten-test-script',
          path: 'src/scripts/forgotten-test.ts',
          type: 'script',
          content: `const value from 'broken'`,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      runtime: normalizeSiteRuntimeConfig({
        scripts: {
          'forgotten-test-script': {
            placement: 'body-end',
            priority: 10,
          },
        },
      }),
    })
    await saveDraftSite(db, shell)
    const page = makeHomePage('Runtime page')
    await createDataRow(db, {
      id: page.id,
      tableId: 'pages',
      cells: pageToCells(page),
      slug: page.slug,
    }, null)

    await expect(publishDraftSite(db, null, undefined, { variants: [{ rowId: 'page_home', localeId: 'default' }] })).rejects.toThrow(
      'Runtime script build failed for page "Home": src/scripts/forgotten-test.ts:1:',
    )
    expect((await db`select id from site_snapshots`).rows).toEqual([])
    expect((await db`select id from data_row_versions`).rows).toEqual([])
  })
})
