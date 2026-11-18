import { expect, test } from 'bun:test'
import { createCapabilityTestHarness, readJson } from '../helpers/capabilityHarness'
import { createDataRow, createDataTable } from '../../../server/repositories/data'
import { insertBranch } from '../../../server/repositories/branches'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import type { CoreCapability } from '../../../server/auth/capabilities'
import type { PagesStats, PostsStats, PublishLineupStats } from '../../../server/repositories/dashboard'

const prefix = '/admin/api/cms/dashboard/'
const widgets = ['pages', 'posts', 'storage', 'publish-lineup', 'media', 'plugins', 'activity']

test('dashboard access requires dashboard and domain capabilities', async () => {
  const h = await createCapabilityTestHarness()
  try {
    const owner = await h.setupOwner()
    await h.createUser({ email: 'dashboard-member@example.test', roleId: 'member' })
    const member = await h.sessionForEmail('dashboard-member@example.test')
    const dashboard = await h.createRoleUser({ name: 'Dashboard', slug: 'dashboard', capabilities: ['dashboard.read'] })
    const domainCaps: CoreCapability[] = ['media.read', 'plugins.read', 'audit.read', 'storage.elect', 'site.read']
    const domain = await h.createRoleUser({ name: 'Domains', slug: 'domains', capabilities: domainCaps })
    const allowed = await h.createRoleUser({ name: 'All widgets', slug: 'all-widgets', capabilities: ['dashboard.read', ...domainCaps] })
    for (const widget of widgets) {
      expect((await h.cms(prefix + widget)).status).toBe(401)
      expect((await h.cms(prefix + widget, { cookie: member })).status).toBe(403)
      expect((await h.cms(prefix + widget, { cookie: domain.cookie })).status).toBe(403)
      expect((await h.cms(prefix + widget, { cookie: dashboard.cookie })).status).toBe(
        ['media', 'plugins', 'activity', 'storage'].includes(widget) ? 403 : 200,
      )
      expect((await h.cms(prefix + widget, { cookie: owner })).status).toBe(200)
      expect((await h.cms(prefix + widget, { cookie: allowed.cookie })).status).toBe(200)
    }
  } finally { await h.cleanup() }
})

const cases: { name: string; caps: CoreCapability[]; system: boolean; custom: boolean; own: boolean; all: boolean }[] = [
  { name: 'dashboard-only', caps: [], system: false, custom: false, own: false, all: false },
  { name: 'site-reader', caps: ['site.read'], system: false, custom: false, own: false, all: false },
  { name: 'table-reader', caps: ['data.system.tables.read', 'data.custom.tables.read'], system: true, custom: true, own: false, all: false },
  { name: 'create-only', caps: ['content.create', 'data.system.tables.read'], system: true, custom: false, own: false, all: false },
  { name: 'own-editor', caps: ['content.edit.own', 'data.system.tables.read'], system: true, custom: false, own: true, all: false },
  { name: 'own-publisher', caps: ['content.publish.own', 'data.custom.tables.read'], system: false, custom: true, own: true, all: false },
  { name: 'custom-editor', caps: ['content.edit.any', 'data.custom.tables.manage'], system: false, custom: true, own: true, all: true },
  { name: 'system-publisher', caps: ['content.publish.any', 'data.system.tables.manage'], system: true, custom: false, own: true, all: true },
  { name: 'content-manager', caps: ['content.manage', 'data.custom.tables.read', 'data.system.tables.read'], system: true, custom: true, own: true, all: true },
]

for (const persona of cases) {
  test(`dashboard visibility ${persona.name}`, async () => {
    const h = await createCapabilityTestHarness()
    try {
      const ownerCookie = await h.setupOwner()
      const { user: owner } = await readJson<{ user: { id: string } }>(await h.cms('/admin/api/cms/me', { cookie: ownerCookie }))
      const actor = await h.createRoleUser({ name: persona.name, slug: persona.name, capabilities: ['dashboard.read', ...persona.caps] })
      const { user } = await readJson<{ user: { id: string } }>(await h.cms('/admin/api/cms/me', { cookie: actor.cookie }))
      const custom = await createDataTable(h.db, MAIN_SCOPE, { name: 'Custom posts', slug: 'custom-posts', kind: 'postType', singularLabel: 'Post', pluralLabel: 'Posts', routeBase: '/custom' })
      // Remove the seeded home row so each expected count has an explicit fixture.
      const now = new Date().toISOString()
      await h.db`update data_rows set deleted_at = ${now}`
      const visibleIds: string[] = []
      const hiddenIds: string[] = []
      for (const [tableId, familyVisible] of [['pages', persona.system], ['posts', persona.system], [custom.id, persona.custom]] as const) {
        for (const [author, readable] of [[user.id, persona.own], [owner.id, persona.all]] as const) {
          for (const status of ['draft', 'scheduled', 'published'] as const) {
            const row = await createDataRow(h.db, MAIN_SCOPE, { tableId, slug: `${tableId}-${author}-${status}`, cells: {} }, author)
            await h.db`update data_rows set status = ${status}, published_at = ${now}, scheduled_publish_at = ${now} where id = ${row.id}`
            ;(familyVisible && readable ? visibleIds : hiddenIds).push(row.id)
          }
        }
      }
      const get = async <T>(widget: string) => {
        const response = await h.cms(prefix + widget + '?tz=Pacific/Honolulu', { cookie: actor.cookie })
        expect(response.status).toBe(200)
        return readJson<T>(response)
      }
      const pages = await get<PagesStats>('pages')
      const authors = Number(persona.own) + Number(persona.all)
      expect(pages).toEqual({ total: persona.system ? authors * 3 : 0, published: persona.system ? authors : 0,
        drafts: persona.system ? authors : 0, scheduled: persona.system ? authors : 0, deltaPublishedThisWeek: persona.system ? authors : 0 })
      const posts = await get<PostsStats>('posts')
      const families = Number(persona.system) + Number(persona.custom)
      expect(posts.total).toBe(families * authors * 3)
      expect(posts.scheduled).toBe(families * authors)
      expect(posts.categories).toBe(families)
      expect(posts.daily28).toHaveLength(28)
      expect(posts.daily28.reduce((a, b) => a + b, 0)).toBe(families * authors)
      expect(posts.daily28[27]).toBe(families * authors)
      const lineup = await get<PublishLineupStats>('publish-lineup')
      expect(lineup.rows.length).toBe(Math.min(3, visibleIds.length / 3) + 2 * Math.min(2, visibleIds.length / 3))
      for (const row of lineup.rows) {
        expect(visibleIds).toContain(row.id)
        expect(hiddenIds).not.toContain(row.id)
        expect((await h.cms(`/admin/api/cms/data/rows/${row.id}`, { cookie: actor.cookie })).status).toBe(200)
        expect(row.at).toBe(row.status === 'draft' ? null : now)
      }
      for (const id of hiddenIds) expect((await h.cms(`/admin/api/cms/data/rows/${id}`, { cookie: actor.cookie })).status).not.toBe(200)
    } finally { await h.cleanup() }
  })
}

test('dashboard filters ownership and deleted or branch rows before lineup limits', async () => {
  const h = await createCapabilityTestHarness()
  try {
    const ownerCookie = await h.setupOwner()
    const { user: owner } = await readJson<{ user: { id: string } }>(await h.cms('/admin/api/cms/me', { cookie: ownerCookie }))
    const actor = await h.createRoleUser({ name: 'Own', slug: 'own', capabilities: ['dashboard.read', 'data.custom.tables.read', 'content.edit.own'] })
    const { user } = await readJson<{ user: { id: string } }>(await h.cms('/admin/api/cms/me', { cookie: actor.cookie }))
    const table = await createDataTable(h.db, MAIN_SCOPE, { name: 'Live', slug: 'live', kind: 'postType', singularLabel: 'Post', pluralLabel: 'Posts', routeBase: '/live' })
    const deleted = await createDataTable(h.db, MAIN_SCOPE, { name: 'Deleted', slug: 'deleted', kind: 'postType', singularLabel: 'Post', pluralLabel: 'Posts' })
    const old = new Date(Date.now() - 86400000).toISOString()
    const recent = new Date().toISOString()
    const expected: string[] = []
    for (let i = 0; i < 3; i++) {
      const row = await createDataRow(h.db, MAIN_SCOPE, { tableId: table.id, slug: `own-${i}`, cells: {} }, user.id)
      await h.db`update data_rows set author_user_id = null, updated_at = ${old} where id = ${row.id}`
      expected.push(row.id)
    }
    // Newer invisible rows must not fill the two draft slots before filtering.
    for (let i = 0; i < 4; i++) {
      const row = await createDataRow(h.db, MAIN_SCOPE, { tableId: table.id, slug: `reassigned-${i}`, cells: {} }, user.id)
      await h.db`update data_rows set author_user_id = ${owner.id}, updated_at = ${recent} where id = ${row.id}`
    }
    const removed = await createDataRow(h.db, MAIN_SCOPE, { tableId: table.id, slug: 'removed', cells: {} }, user.id)
    await h.db`update data_rows set deleted_at = ${recent} where id = ${removed.id}`
    await createDataRow(h.db, MAIN_SCOPE, { tableId: deleted.id, slug: 'hidden-table-row', cells: {} }, user.id)
    await h.db`update data_tables set deleted_at = ${recent} where id = ${deleted.id}`
    await insertBranch(h.db, { id: 'dashboard-test', name: 'Private branch', baseBranchId: 'main', createdByUserId: owner.id })
    const branch = { branchId: 'dashboard-test' }
    const branchTable = await createDataTable(h.db, branch, { id: table.id, name: 'Branch', slug: 'branch', kind: 'postType', singularLabel: 'Post', pluralLabel: 'Posts' })
    await createDataRow(h.db, branch, { tableId: branchTable.id, slug: 'branch-row', cells: {} }, user.id)
    const lineup = await readJson<PublishLineupStats>(await h.cms(prefix + 'publish-lineup', { cookie: actor.cookie }))
    expect(lineup.rows).toHaveLength(2)
    for (const row of lineup.rows) {
      expect(expected).toContain(row.id)
      expect(row.path).toStartWith('/live/own-')
    }
    const posts = await readJson<PostsStats>(await h.cms(prefix + 'posts', { cookie: actor.cookie }))
    expect(posts.total).toBe(3)
    expect(posts.categories).toBe(1)
    // Permissions are resolved afresh, even with the same session cookie.
    await h.db`update roles set capabilities_json = ${['dashboard.read']} where id = ${actor.roleId}`
    expect((await readJson<PublishLineupStats>(await h.cms(prefix + 'publish-lineup', { cookie: actor.cookie }))).rows).toEqual([])
  } finally { await h.cleanup() }
})
