import { describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, expectForbidden, readJson } from '../helpers/capabilityHarness'
import type { DataTable } from '@core/data/schemas'

const TABLES = '/admin/api/cms/data/tables'

describe('data system-table visibility + lockdown', () => {
  it('preserves explicitly blank route bases through API create and PATCH', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()
      const createdResponse = await harness.cms(TABLES, {
        method: 'POST',
        cookie: ownerCookie,
        json: {
          name: 'Fee lines',
          slug: 'fee-lines',
          kind: 'data',
          routeBase: '',
          singularLabel: 'Fee line',
          pluralLabel: 'Fee lines',
        },
      })
      expect(createdResponse.status).toBe(201)
      const created = (await readJson<{ table: DataTable }>(createdResponse)).table
      expect(created.routeBase).toBe('')

      const routedResponse = await harness.cms(`${TABLES}/${created.id}`, {
        method: 'PATCH',
        cookie: ownerCookie,
        json: { routeBase: '  /fees/  ' },
      })
      expect(routedResponse.status).toBe(200)
      expect((await readJson<{ table: DataTable }>(routedResponse)).table.routeBase).toBe('/fees')

      const blankResponse = await harness.cms(`${TABLES}/${created.id}`, {
        method: 'PATCH',
        cookie: ownerCookie,
        json: { routeBase: '   ' },
      })
      expect(blankResponse.status).toBe(200)
      expect((await readJson<{ table: DataTable }>(blankResponse)).table.routeBase).toBe('')

      const { rows } = await harness.db<{ route_base: string }>`
        select route_base from data_tables where id = ${created.id}
      `
      expect(rows[0]?.route_base).toBe('')
    } finally {
      await harness.cleanup()
    }
  })

  it('does not create a template page when creating a post-type table', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()
      const before = await harness.db<{ count: number }>`
        select count(*) as count from data_rows where table_id = 'pages' and deleted_at is null
      `

      const created = await harness.cms(TABLES, {
        method: 'POST',
        cookie: ownerCookie,
        json: {
          name: 'Products',
          slug: 'products',
          kind: 'postType',
          routeBase: '/products',
          singularLabel: 'Product',
          pluralLabel: 'Products',
          primaryFieldId: 'title',
          fields: [
            { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
            { type: 'text', id: 'slug', label: 'Slug', required: true, builtIn: true },
            { type: 'richText', id: 'body', label: 'Body', format: 'markdown', builtIn: true },
          ],
        },
      })
      expect(created.status).toBe(201)

      const after = await harness.db<{ count: number }>`
        select count(*) as count from data_rows where table_id = 'pages' and deleted_at is null
      `
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count)
    } finally {
      await harness.cleanup()
    }
  })

  it('hides system tables from a custom-only persona but shows them to the owner', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()

      const ownerList = await harness.cms(TABLES, { method: 'GET', cookie: ownerCookie })
      expect(ownerList.status).toBe(200)
      const ownerSlugs = (await readJson<{ tables: DataTable[] }>(ownerList)).tables.map((t) => t.slug)
      // Owner has data.system.tables.read → sees the seeded system tables.
      expect(ownerSlugs).toContain('layouts')
      expect(ownerSlugs).toContain('pages')

      const client = await harness.createRoleUser({
        name: 'Custom Only',
        slug: 'custom-only',
        capabilities: ['data.custom.tables.read'],
      })
      const clientList = await harness.cms(TABLES, { method: 'GET', cookie: client.cookie })
      expect(clientList.status).toBe(200)
      const clientTables = (await readJson<{ tables: DataTable[] }>(clientList)).tables
      // No system tables leak to a custom-only persona.
      expect(clientTables.some((t) => t.system)).toBe(false)
    } finally {
      await harness.cleanup()
    }
  })

  it('freezes a system table identity but allows adding custom fields', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()

      // Resolve the seeded `layouts` system table id.
      const list = await harness.cms(TABLES, { method: 'GET', cookie: ownerCookie })
      const layouts = (await readJson<{ tables: DataTable[] }>(list)).tables.find((t) => t.slug === 'layouts')
      expect(layouts?.system).toBe(true)
      const path = `${TABLES}/${layouts!.id}`

      // Renaming a system table is rejected (frozen identity).
      const rename = await harness.cms(path, { method: 'PATCH', cookie: ownerCookie, json: { name: 'Renamed' } })
      expect(rename.status).toBe(400)

      // Removing/editing built-in fields is rejected.
      const dropBuiltIn = await harness.cms(path, {
        method: 'PATCH',
        cookie: ownerCookie,
        json: { fields: layouts!.fields.filter((f) => f.builtIn !== true) },
      })
      expect(dropBuiltIn.status).toBe(400)

      // Adding a custom field is allowed.
      const addCustom = await harness.cms(path, {
        method: 'PATCH',
        cookie: ownerCookie,
        json: {
          fields: [...layouts!.fields, { id: 'note', label: 'Note', type: 'text' }],
        },
      })
      expect(addCustom.status).toBe(200)
      const updated = await readJson<{ table: DataTable }>(addCustom)
      expect(updated.table.fields.some((f) => f.id === 'note')).toBe(true)
    } finally {
      await harness.cleanup()
    }
  })

  it('denies system-table management to a system-read-only persona', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()
      const list = await harness.cms(TABLES, { method: 'GET', cookie: ownerCookie })
      const layouts = (await readJson<{ tables: DataTable[] }>(list)).tables.find((t) => t.slug === 'layouts')

      const viewer = await harness.createRoleUser({
        name: 'System Viewer',
        slug: 'system-viewer',
        capabilities: ['data.system.tables.read'],
      })
      const steppedCookie = await harness.stepUp(viewer.cookie)
      const attempt = await harness.cms(`${TABLES}/${layouts!.id}`, {
        method: 'PATCH',
        cookie: steppedCookie,
        json: { primaryFieldId: 'name' },
      })
      await expectForbidden(attempt)
    } finally {
      await harness.cleanup()
    }
  })
})
