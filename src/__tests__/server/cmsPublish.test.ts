import { describe, expect, it } from 'bun:test'
import type { SiteDocument, SiteShell } from '@core/page-tree'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import type { DbResult } from '../../../server/db'
import { saveDraftSite } from '../../../server/repositories/site'
import {
  getDraftPublishStatus,
  getPublishedPageBySlug,
  publishDraftSite,
} from '../../../server/repositories/publish'
import { createDataRow, saveDataRowDraft } from '../../../server/repositories/data'
import { pageToCells } from '../../../src/core/data/pageFromRow'
import { createFakeDb } from './dbTestFake'

function createPublishFakeDb() {
  const state = {
    site: null as Record<string, unknown> | null,
    dataRows: [] as Record<string, unknown>[],
    dataRowVersions: [] as Record<string, unknown>[],
    siteSnapshots: [] as Record<string, unknown>[],
    runtimeAssets: [] as Record<string, unknown>[],
  }

  const db = createFakeDb(async (rawSql, params): Promise<DbResult> => {
    const sql = rawSql.replace(/\s+/g, ' ').trim().toLowerCase()

    // saveDraftSite — insert or update site row (NOT site_snapshots)
    if (sql.startsWith('insert into site (')) {
      state.site = {
        id: 'default',
        name: params[0],
        settings_json: params[1],
        created_at: new Date('2026-01-01').toISOString(),
        updated_at: new Date('2026-01-02').toISOString(),
      }
      return { rows: [], rowCount: 1 }
    }
    // getDraftSite — select site row
    if (sql.startsWith('select id, name, settings_json')) {
      return { rows: state.site ? [state.site] : [], rowCount: state.site ? 1 : 0 }
    }
    // createDataRow — insert into data_rows returning id
    if (sql.startsWith('insert into data_rows')) {
      const row = {
        id: params[0],
        table_id: params[1],
        cells_json: params[2],
        slug: params[3],
        status: params[4],
        author_user_id: params[5],
        created_by_user_id: params[6],
        updated_by_user_id: params[7],
        active_version_id: null,
        published_by_user_id: null,
        published_at: null,
        created_at: new Date('2026-01-01').toISOString(),
        updated_at: new Date('2026-01-01').toISOString(),
        deleted_at: null,
      }
      const idx = state.dataRows.findIndex((r) => r.id === row.id)
      if (idx >= 0) state.dataRows[idx] = row
      else state.dataRows.push(row)
      return { rows: [{ id: row.id }], rowCount: 1 }
    }
    // saveDataRowDraft — update data_rows set cells_json, slug, updated_by_user_id, plugin_actor_id
    // params: [0]=cells_json, [1]=slug, [2]=updated_by_user_id, [3]=plugin_actor_id, [4]=rowId
    if (sql.startsWith('update data_rows set cells_json')) {
      const row = state.dataRows.find((r) => r.id === params[4])
      if (row) {
        row.cells_json = params[0]
        row.slug = params[1]
        row.updated_by_user_id = params[2]
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    // listDataRows for pages — select from data_rows where table_id = 'pages'
    if (sql.includes('from data_rows') && sql.includes('left join users')) {
      const rows = state.dataRows
        .filter((r) => r.deleted_at == null)
        .map((r) => ({
          ...r,
          author_email: null,
          author_display_name: null,
          author_role_slug: null,
          author_role_name: null,
          created_by_email: null,
          created_by_display_name: null,
          created_by_role_slug: null,
          created_by_role_name: null,
          updated_by_email: null,
          updated_by_display_name: null,
          updated_by_role_slug: null,
          updated_by_role_name: null,
          published_by_email: null,
          published_by_display_name: null,
          published_by_role_slug: null,
          published_by_role_name: null,
        }))
      return { rows, rowCount: rows.length }
    }
    // nextVersionNumber — max(version_number) + 1
    if (sql.startsWith('select coalesce(max(version_number)')) {
      const rowId = params[0] as string
      const rowVersions = state.dataRowVersions.filter((v) => v.row_id === rowId)
      const nextVersion = Math.max(0, ...rowVersions.map((v) => Number(v.version_number))) + 1
      return { rows: [{ next_version: nextVersion }], rowCount: 1 }
    }
    // insert into site_snapshots — one per publish, referenced by version rows
    if (sql.startsWith('insert into site_snapshots')) {
      state.siteSnapshots.push({
        id: params[0],
        site_json: params[1],
        content_hash: params[2],
        importmap_body: params[3],
        importmap_sha256: params[4],
      })
      return { rows: [], rowCount: 1 }
    }
    // insert into data_row_versions
    // columns: (id, row_id, version_number, cells_json, slug, site_snapshot_id,
    //           runtime_assets_json, published_by_user_id)
    if (sql.startsWith('insert into data_row_versions')) {
      state.dataRowVersions.push({
        id: params[0],
        row_id: params[1],
        version_number: params[2],
        cells_json: params[3],
        slug: params[4],
        site_snapshot_id: params[5],
        runtime_assets_json: params[6],
        published_by_user_id: params[7],
        published_at: new Date('2026-01-03').toISOString(),
      })
      return { rows: [], rowCount: 1 }
    }
    // savePublishedRuntimeAssets — insert into published_runtime_assets
    if (sql.startsWith('insert into published_runtime_assets')) {
      state.runtimeAssets.push({
        id: params[0],
        page_version_id: params[1],
        asset_path: params[2],
        public_path: params[3],
        content_type: params[4],
        content_bytes: params[5],
      })
      return { rows: [], rowCount: 1 }
    }
    // update data_rows set active_version_id = $1 ... (after publish)
    // SQL params: $1=versionId, $2=publishedByUserId, $3=updatedByUserId, $4=rowId
    if (sql.startsWith('update data_rows') && sql.includes('active_version_id')) {
      const versionId = params[0] as string
      const publishedBy = params[1] as string
      const rowId = params[3] as string
      const row = state.dataRows.find((r) => r.id === rowId)
      if (row) {
        row.active_version_id = versionId
        row.status = 'published'
        row.published_by_user_id = publishedBy
        row.published_at = new Date('2026-01-03').toISOString()
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    // getPublishedPageBySlug — join data_rows + data_row_versions + site_snapshots
    if (sql.includes('site_snapshots.site_json') && sql.includes('data_rows.slug')) {
      const slug = params[0] as string
      const row = state.dataRows.find((r) => r.slug === slug && r.status === 'published')
      const version = row ? state.dataRowVersions.find((v) => v.id === row.active_version_id) : null
      const snap = version
        ? state.siteSnapshots.find((s) => s.id === version.site_snapshot_id)
        : null
      return {
        rows: version && snap
          ? [{
              row_id: version.row_id,
              site_json: snap.site_json,
              runtime_assets_json: version.runtime_assets_json,
              importmap_body: snap.importmap_body,
              importmap_sha256: snap.importmap_sha256,
            }]
          : [],
        rowCount: version && snap ? 1 : 0,
      }
    }
    // getDraftPublishStatus — published rows join (selects the per-publish content hash)
    if (sql.includes('site_snapshots.content_hash') && sql.includes('created_at asc')) {
      const rows = state.dataRows
        .filter((r) => r.status === 'published' && r.active_version_id && !r.deleted_at)
        .map((r) => {
          const ver = state.dataRowVersions.find((v) => v.id === r.active_version_id)
          const snap = ver
            ? state.siteSnapshots.find((s) => s.id === ver.site_snapshot_id)
            : null
          return ver && snap ? {
            row_id: r.id,
            content_hash: snap.content_hash,
            published_at: ver.published_at,
          } : null
        })
        .filter(Boolean)
      return { rows, rowCount: rows.length }
    }
    throw new Error(`Unhandled SQL: ${rawSql}`)
  })

  return { state, db }
}

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
  db: ReturnType<typeof createPublishFakeDb>['db'],
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
  }, 'admin_1')
}

describe('CMS publishing', () => {
  it('publishes draft pages as immutable active snapshots', async () => {
    const { state, db } = createPublishFakeDb()
    await seedSiteAndPage(db, 'Published headline')

    const result = await publishDraftSite(db, 'admin_1')
    const published = await getPublishedPageBySlug(db, 'index')

    expect(result).toMatchObject({ publishedPages: 1 })
    expect(state.dataRowVersions).toHaveLength(1)
    expect(published?.site.pages[0].nodes.text_1.props.text).toBe('Published headline')
  })

  it('does not expose later draft changes until another publish occurs', async () => {
    const { db } = createPublishFakeDb()
    await seedSiteAndPage(db, 'Public version')
    await publishDraftSite(db, 'admin_1')

    // Update the draft page text
    await saveDataRowDraft(db, 'page_home', {
      cells: pageToCells({ ...makeHomePage('Draft only') }),
      slug: 'index',
    }, 'admin_1')
    const published = await getPublishedPageBySlug(db, 'index')

    expect(published?.site.pages[0].nodes.text_1.props.text).toBe('Public version')
  })

  it('reports that the current draft matches the active published snapshots after publishing', async () => {
    const { db } = createPublishFakeDb()
    await seedSiteAndPage(db, 'Public version')
    await publishDraftSite(db, 'admin_1')

    const status = await getDraftPublishStatus(db)

    expect(status).toMatchObject({
      hasPublishedVersion: true,
      draftMatchesPublished: true,
      draftPages: 1,
      publishedPages: 1,
    })
    expect(status.lastPublishedAt).toBeTruthy()
  })

  it('reports that the current draft no longer matches after a later draft save', async () => {
    const { db } = createPublishFakeDb()
    await seedSiteAndPage(db, 'Public version')
    await publishDraftSite(db, 'admin_1')

    // Update the draft to create mismatch
    await saveDataRowDraft(db, 'page_home', {
      cells: pageToCells({ ...makeHomePage('Draft only') }),
      slug: 'index',
    }, 'admin_1')

    const status = await getDraftPublishStatus(db)

    expect(status).toMatchObject({
      hasPublishedVersion: true,
      draftMatchesPublished: false,
      draftPages: 1,
      publishedPages: 1,
    })
  })

  it('stores built runtime assets with the published page version', async () => {
    const { state, db } = createPublishFakeDb()
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
    }, 'admin_1')

    await publishDraftSite(db, 'admin_1')
    const published = await getPublishedPageBySlug(db, 'index')

    expect(state.runtimeAssets.length).toBeGreaterThan(0)
    expect(String(state.runtimeAssets[0].public_path)).toContain('/_instatic/assets/')
    expect(published?.runtimeAssets?.scripts).toHaveLength(1)
    expect(published?.runtimeAssets?.scripts[0].src).toBe(state.runtimeAssets[0].public_path)
  })
})
