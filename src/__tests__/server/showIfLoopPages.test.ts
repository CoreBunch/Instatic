/**
 * A later page of an infinite list (`/_instatic/loop/<id>?page=N`) renders
 * its items with the route frame of the page the list sits on (`pagePath`),
 * so `{route.query.*}` tokens and query show-if conditions read the same
 * query the first page was rendered for.
 */
import '@modules/base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page, SiteShell } from '@core/page-tree'
import { loopSourceRegistry } from '@core/loops/registry'
import type { LoopEntitySource, SourceFetchContext } from '@core/loops/types'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { pageToCells } from '../../core/data/pageFromRow'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { getPublishedNodeIndexForVersion } from '../../../server/publish/publishedSnapshotCache'
import { getPublishVersion } from '../../../server/publish/publishState'
import { resetForTests } from '../../../server/publish/renderCache'
import { createDataRow } from '../../../server/repositories/data'
import { saveDraftSite } from '../../../server/repositories/site'
import { handleServerRequest } from '../../../server/router'
import { createTestDb, type TestDb } from '../helpers/createTestDb'

const SOURCE = 'test.showif.items'
type Node = Page['nodes'][string]

function node(id: string, moduleId: string, props: Record<string, unknown>, children: string[] = []): Node {
  return { id, moduleId, props, breakpointOverrides: {}, children, classIds: [] } as Node
}

const source: LoopEntitySource = {
  id: SOURCE,
  label: SOURCE,
  filterSchema: {},
  orderByOptions: [],
  fields: [{ id: 'label', label: 'Label' }],
  fetch: async (ctx: SourceFetchContext) => {
    const items = ['one', 'two', 'three'].map((label) => ({ id: label, fields: { label } }))
    return { items: items.slice(ctx.offset, ctx.offset + ctx.limit), totalItems: items.length }
  },
  preview: () => [],
}

function page(): Page {
  const nodes = [
    node('root', 'base.body', {}, ['list']),
    node('list', 'base.loop', {
      sourceId: SOURCE, filters: {}, orderBy: '', limit: 10, offset: 0,
      pagination: 'infinite', pageSize: 1, tag: 'div', customTag: '',
    }, ['card']),
    node('card', 'base.container', {}, ['item', 'flag']),
    node('item', 'base.text', { text: 'ITEM[{currentEntry.label}|{route.query.status}]', tag: 'p' }),
    node('flag', 'base.text', {
      text: 'FLAG-SHOWN', tag: 'p', showIf: { source: 'query', name: 'status', test: 'equals', value: 'ok' },
    }),
  ]
  return { id: 'page_home', title: 'Home', slug: 'index', rootNodeId: 'root', nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) } as Page
}

describe('later pages of an infinite list', () => {
  let t: TestDb
  let uploadsDir: string

  beforeEach(async () => {
    resetForTests()
    loopSourceRegistry.registerOrReplace(source)
    t = await createTestDb()
    uploadsDir = await mkdtemp(join(tmpdir(), 'showif-loop-'))
    await t.db`
      insert into users (id, email, email_normalized, display_name, password_hash, role_id)
      values ('admin_1', 'admin@example.test', 'admin@example.test', 'Admin', 'x', 'owner')
    `
  })

  async function publish(conditionOnOutletWrapper = false) {
    const shell: SiteShell = {
      id: 'site_1', name: 'Show-if Site', files: [], visualComponents: [],
      breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
      settings: { shortcuts: {} }, styleRules: {}, packageJson: { dependencies: {}, devDependencies: {} },
      runtime: normalizeSiteRuntimeConfig(undefined), createdAt: 1000, updatedAt: 2000,
    }
    await saveDraftSite(t.db, MAIN_SCOPE, shell)
    // A site-wide layout, and an account page inside it whose notice shows
    // only for ?commerce=plan_changed (the commerce plugin's return address).
    const layout = {
      id: 'page_layout', title: 'Layout', slug: 'layout', rootNodeId: 'lay_root',
      template: { enabled: true, target: { kind: 'everywhere' }, priority: 0 },
      nodes: Object.fromEntries([
        node('lay_root', 'base.body', {}, ['lay_main']),
        node('lay_main', 'base.container', conditionOnOutletWrapper
          ? { showIf: { source: 'query', name: 'commerce', test: 'notEquals', value: 'hide' } }
          : {}, ['lay_outlet']),
        node('lay_outlet', 'base.outlet', {}),
      ].map((n) => [n.id, n])),
    } as unknown as Page
    const account = {
      id: 'page_account', title: 'Account', slug: 'account', rootNodeId: 'acc_root',
      nodes: Object.fromEntries([
        node('acc_root', 'base.body', {}, ['acc_title', 'acc_notice']),
        node('acc_title', 'base.text', { text: 'ACCOUNT-PAGE', tag: 'h1' }),
        node('acc_notice', 'base.text', {
          text: 'PLAN-CHANGED-NOTICE', tag: 'p',
          showIf: { source: 'query', name: 'commerce', test: 'equals', value: 'plan_changed' },
        }),
      ].map((n) => [n.id, n])),
    } as Page
    for (const p of [page(), layout, account]) {
      await createDataRow(t.db, MAIN_SCOPE, { id: p.id, tableId: 'pages', cells: pageToCells(p), slug: p.slug }, 'admin_1')
    }
    await publishDraftSite(t.db, 'admin_1', uploadsDir)
  }

  afterEach(async () => {
    loopSourceRegistry.unregister(SOURCE)
    await t.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('reads the query of the page the list sits on', async () => {
    await publish()
    const res = await handleServerRequest(
      new Request(`http://localhost/_instatic/loop/c0_list?page=2&pagePath=${encodeURIComponent('/?status=ok')}`),
      { db: t.db, uploadsDir },
    )
    expect(res.status).toBe(200)
    const { html } = (await res.json()) as { html: string }
    expect(html).toContain('ITEM[two|ok]')
    expect(html).toContain('FLAG-SHOWN')

    const other = await handleServerRequest(
      new Request(`http://localhost/_instatic/loop/c0_list?page=2&pagePath=${encodeURIComponent('/?status=no')}`),
      { db: t.db, uploadsDir },
    )
    const { html: otherHtml } = (await other.json()) as { html: string }
    expect(otherHtml).toContain('ITEM[two|no]')
    expect(otherHtml).not.toContain('FLAG-SHOWN')
  })

  it('shows a query-conditioned notice on a page inside a layout, for that query only', async () => {
    await publish()
    const served = await (await handleServerRequest(new Request('http://localhost/account?commerce=plan_changed'), { db: t.db, uploadsDir })).text()
    expect(served).toContain('ACCOUNT-PAGE')
    // The notice is a fragment, under the id the composed page carries.
    expect(served).toContain('data-instatic-hole="c0_acc_notice"')
    expect(served).not.toContain('PLAN-CHANGED-NOTICE')

    const site = await getPublishedNodeIndexForVersion(t.db, getPublishVersion())
    const fragment = async (u: string) => (await handleServerRequest(
      new Request(`http://localhost/_instatic/hole/c0_acc_notice?v=${site!.snapshotHash}&u=${encodeURIComponent(u)}`),
      { db: t.db, uploadsDir },
    )).text()
    expect(await fragment('/account?commerce=plan_changed')).toContain('PLAN-CHANGED-NOTICE')
    expect(await fragment('/account')).not.toContain('PLAN-CHANGED-NOTICE')
    expect(await fragment('/account?commerce=cancelled')).not.toContain('PLAN-CHANGED-NOTICE')
  })
  it('renders a layout wrapper with the matching page in its outlet', async () => {
    await publish(true)
    const get = async (path: string) => {
      const response = await handleServerRequest(new Request('http://localhost' + path), { db: t.db, uploadsDir })
      expect(response.status).toBe(200)
      return response.text()
    }
    const shell = await get('/account?commerce=plan_changed')
    const wrapper = /data-instatic-hole="([^"]+)"/.exec(shell)?.[1]
    expect(wrapper).toBeTruthy()
    expect(shell).not.toContain('ACCOUNT-PAGE')
    const site = await getPublishedNodeIndexForVersion(t.db, getPublishVersion())
    const fragment = (query: string) => get(`/_instatic/hole/${wrapper}?v=${site!.snapshotHash}&u=${encodeURIComponent('/account' + query)}`)
    const visible = await fragment('?commerce=plan_changed')
    expect(visible).toContain('ACCOUNT-PAGE')
    expect(visible).toContain('PLAN-CHANGED-NOTICE')
    expect(await fragment('?commerce=hide')).not.toContain('ACCOUNT-PAGE')
  })
})
