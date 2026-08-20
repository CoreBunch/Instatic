import { beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/db'
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'
import { republishAllPages } from '../../../server/publish/republish'
import { hookBus } from '@core/plugins/hookBus'
import { makePage } from '../publisher/helpers'
import { createFakeDb } from './dbTestFake'

function makeSnapshots(): Map<string, PublishedPageSnapshot> {
  const home = makePage({
    root: { moduleId: 'base.body', children: ['copy'] },
    copy: { moduleId: 'base.text', props: { text: 'Home', tag: 'h1' } },
  })
  home.id = 'page-home'
  home.slug = 'index'
  home.title = 'Home'

  const template = makePage({
    root: { moduleId: 'base.body', children: ['outlet'] },
    outlet: { moduleId: 'base.outlet' },
  })
  template.id = 'page-template'
  template.slug = 'post-template'
  template.title = 'Post template'
  template.template = {
    enabled: true,
    target: { kind: 'postTypes', tableSlugs: ['posts'] },
    priority: 0,
  }

  const site = {
    id: 'site-1',
    name: 'Republish test',
    pages: [home, template],
    files: [],
    visualComponents: [],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: { metaTitle: 'Republish test', shortcuts: {} },
    styleRules: {},
    createdAt: 1,
    updatedAt: 1,
  }

  return new Map([
    [home.id, { cmsSnapshotVersion: 1, pageRowId: home.id, site }],
    [template.id, { cmsSnapshotVersion: 1, pageRowId: template.id, site }],
  ])
}

function makeFakeDb(snapshots: Map<string, PublishedPageSnapshot>): DbClient {
  return createFakeDb(async (sql: string, params: unknown[]): Promise<DbResult> => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.startsWith('select id from data_rows')) {
      return {
        rows: [...snapshots.keys()].map((id) => ({ id })),
        rowCount: snapshots.size,
      }
    }

    if (normalized.includes('site_snapshots.site_json')) {
      const snapshot = snapshots.get(String(params[0]))
      return {
        rows: snapshot
          ? [{
              row_id: snapshot.pageRowId,
              site_json: snapshot.site,
              runtime_assets_json: null,
              importmap_body: null,
              importmap_sha256: null,
            }]
          : [],
        rowCount: snapshot ? 1 : 0,
      }
    }

    return { rows: [], rowCount: 0 }
  })
}

describe('background republish', () => {
  beforeEach(() => {
    hookBus.reset()
  })

  it('republishes directly routable pages and skips template documents', async () => {
    const contexts: Array<Record<string, unknown>> = []
    hookBus.filter('republish-test', 'publish.html', (html, context) => {
      contexts.push(context)
      return html
    })

    const count = await republishAllPages(makeFakeDb(makeSnapshots()))

    expect(count).toBe(1)
    expect(contexts).toEqual([{
      pluginId: 'republish-test',
      siteId: 'site-1',
      pageId: 'page-home',
      slug: 'index',
      path: '/',
    }])
  })
})
