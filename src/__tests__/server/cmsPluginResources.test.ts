import { describe, expect, it } from 'bun:test'
import { SESSION_COOKIE_NAME, hashSessionToken } from '../../../server/auth/tokens'
import type { DbClient, DbResult } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'

function makeFakeDb() {
  const admins: Record<string, unknown>[] = [
    {
      id: 'admin_1',
      email: 'owner@example.com',
      password_hash: 'hash',
      created_at: new Date('2026-01-01').toISOString(),
    },
  ]
  const sessions: Record<string, unknown>[] = []
  const plugins: Record<string, unknown>[] = []
  const records: Record<string, unknown>[] = []

  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    // Reconstruct a parameterized SQL string for pattern matching.
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.includes('from sessions') && normalized.includes('join users')) {
      const session = sessions.find((s) => String(s.id_hash) === String(values[0]))
      if (!session) return { rows: [], rowCount: 0 }
      const admin = admins.find((a) => a.id === session.user_id)
      return {
        rows: admin ? [{
          ...admin,
          email_normalized: admin.email,
          display_name: 'Owner',
          status: 'active',
          role_id: 'owner',
          last_login_at: null,
          updated_at: admin.created_at,
          deleted_at: null,
          role_slug: 'owner',
          role_name: 'Owner',
          role_description: '',
          role_is_system: true,
          role_capabilities_json: ['plugins.read', 'plugins.configure', 'plugins.install', 'plugins.lifecycle'],
        } as Row] : [],
        rowCount: admin ? 1 : 0,
      }
    }
    if (normalized.includes('update sessions') && normalized.includes('last_seen_at')) {
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('insert into audit_events')) {
      return { rows: [], rowCount: 1 }
    }
    // `requireStepUp` lookup — JSON plugin install (and other sensitive
    // plugin admin endpoints) now require a fresh step-up window. The
    // record CRUD calls themselves don't trigger this, but the test
    // installs the plugin via POST /admin/api/cms/plugins first, which
    // does. `createCookie` stamps a far-future expiry.
    if (normalized.includes('select step_up_expires_at') && normalized.includes('from sessions')) {
      const session = sessions.find((s) => String(s.id_hash) === String(values[0]))
      if (!session) return { rows: [], rowCount: 0 }
      return {
        rows: [{ step_up_expires_at: session.step_up_expires_at ?? null } as Row],
        rowCount: 1,
      }
    }
    // getInstalledPlugin — values[0]=id (check with id = $1 to distinguish from list)
    if (normalized.includes('select id, name, version, enabled') && normalized.includes('where id = $1')) {
      const plugin = plugins.find((candidate) => candidate.id === values[0])
      return { rows: plugin ? [plugin as Row] : [], rowCount: plugin ? 1 : 0 }
    }
    // listInstalledPlugins — no values
    if (normalized.includes('select id, name, version, enabled')) {
      return { rows: [...plugins] as Row[], rowCount: plugins.length }
    }
    // installPlugin — values[0..4]=id, name, version, manifestJson, permsJson
    if (normalized.includes('insert into installed_plugins')) {
      const now = new Date('2026-05-01T10:00:00.000Z').toISOString()
      const row = {
        id: values[0],
        name: values[1],
        version: values[2],
        enabled: true,
        lifecycle_status: 'installed',
        last_error: null,
        manifest_json: values[3],
        granted_permissions_json: values[4] ?? [],
        installed_at: now,
        updated_at: now,
      }
      plugins.push(row)
      return { rows: [row as Row], rowCount: 1 }
    }
    // setPluginLifecycleStatus — values[0]=lifecycleStatus, values[1]=lastError, values[2]=id
    if (normalized.includes('update installed_plugins set lifecycle_status')) {
      const row = plugins.find((plugin) => plugin.id === values[2])
      if (!row) return { rows: [], rowCount: 0 }
      row.lifecycle_status = values[0]
      row.last_error = values[1] ?? null
      row.updated_at = new Date('2026-05-01T10:06:00.000Z').toISOString()
      return { rows: [row as Row], rowCount: 1 }
    }
    // listPluginRecords now uses db.unsafe(); this branch handles any
    // remaining tagged-template callers that still produce this pattern.
    if (normalized.includes('select id, plugin_id, resource_id, data_json')) {
      const rows = records.filter((record) =>
        record.plugin_id === values[0] && record.resource_id === values[1]
      )
      return { rows: rows as Row[], rowCount: rows.length }
    }
    // Plugin crash events — list/insert/delete. The cms handler's
    // `pluginsPayload` calls `listPluginCrashes` for every plugin, so the
    // fake DB has to recognise these queries even when the test never
    // simulates a worker crash.
    if (normalized.includes('insert into plugin_crash_events')) {
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('select id, plugin_id, occurred_at, reason, stack')
        && normalized.includes('from plugin_crash_events')) {
      return { rows: [] as Row[], rowCount: 0 }
    }
    if (normalized.includes('delete from plugin_crash_events')) {
      return { rows: [], rowCount: 0 }
    }

    // createPluginRecord — values[0..3]=id, pluginId, resourceId, dataJson
    if (normalized.includes('insert into plugin_records')) {
      const now = new Date('2026-05-01T10:10:00.000Z').toISOString()
      const row = {
        id: values[0],
        plugin_id: values[1],
        resource_id: values[2],
        data_json: values[3],
        created_at: now,
        updated_at: now,
      }
      records.push(row)
      return { rows: [row as Row], rowCount: 1 }
    }
    // updatePluginRecord — values[0]=dataJson, values[1]=id, values[2]=pluginId, values[3]=resourceId
    if (normalized.includes('update plugin_records set data_json')) {
      const row = records.find((record) =>
        record.id === values[1] &&
        record.plugin_id === values[2] &&
        record.resource_id === values[3]
      )
      if (!row) return { rows: [], rowCount: 0 }
      row.data_json = values[0]
      row.updated_at = new Date('2026-05-01T10:15:00.000Z').toISOString()
      return { rows: [row as Row], rowCount: 1 }
    }
    // deletePluginRecord — values[0]=id, values[1]=pluginId, values[2]=resourceId
    if (normalized.includes('delete from plugin_records')) {
      const index = records.findIndex((record) =>
        record.id === values[0] &&
        record.plugin_id === values[1] &&
        record.resource_id === values[2]
      )
      if (index === -1) return { rows: [], rowCount: 0 }
      records.splice(index, 1)
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  // listPluginRecords uses db.unsafe() for its dynamic SQL queries.
  // Handle the two shapes: the data SELECT and the COUNT(*) query.
  const handleUnsafe = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<DbResult<Row>> => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.includes('from plugin_records') && normalized.includes('count(*)')) {
      // COUNT query — params[0]=pluginId, params[1]=resourceId (matching the WHERE clause)
      const pluginId = params?.[0]
      const resourceId = params?.[1]
      const count = records.filter((record) =>
        record.plugin_id === pluginId && record.resource_id === resourceId
      ).length
      return { rows: [{ total: count } as Row], rowCount: 1 }
    }
    if (normalized.includes('select id, plugin_id, resource_id, data_json')
        && normalized.includes('from plugin_records')) {
      // Data query — params[0]=pluginId, params[1]=resourceId (LIMIT/OFFSET are last two params)
      const pluginId = params?.[0]
      const resourceId = params?.[1]
      const matched = records.filter((record) =>
        record.plugin_id === pluginId && record.resource_id === resourceId
      )
      return { rows: matched as Row[], rowCount: matched.length }
    }
    // users + sessions repositories also issue their hydrating SELECTs through
    // db.unsafe(); re-dispatch those through the tagged-template matcher by
    // splitting the raw SQL on its positional placeholders.
    return handle<Row>(sql.split(/\$\d+|\?/) as unknown as TemplateStringsArray, ...(params ?? []))
  }

  return Object.assign(handle as DbClient, {
    admins,
    sessions,
    plugins,
    records,
    unsafe: handleUnsafe,
    dialect: 'sqlite' as const,
  })
}

async function createCookie(db: ReturnType<typeof makeFakeDb>): Promise<string> {
  const token = 'valid-session-token'
  db.sessions.push({
    id_hash: await hashSessionToken(token),
    user_id: 'admin_1',
    expires_at: new Date('2030-01-01').toISOString(),
    // Fresh step-up window — the JSON plugin install path the test calls
    // now requires one. Pinned far in the future so existing tests behave
    // as before.
    step_up_expires_at: new Date('2030-01-01').toISOString(),
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

function cmsRequest(
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Request {
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    url,
    method: init.method ?? 'GET',
    headers: {
      get(name: string) {
        return headers.get(name.toLowerCase()) ?? null
      },
    },
    async json() {
      return init.body ? JSON.parse(init.body) : {}
    },
  } as Request
}

const booksPlugin = {
  id: 'acme.books',
  name: 'Books',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['admin.navigation', 'cms.storage'],
  resources: [
    {
      id: 'books',
      title: 'Books',
      singularLabel: 'Book',
      pluralLabel: 'Books',
      fields: [
        { id: 'title', label: 'Title', type: 'text', required: true },
        { id: 'author', label: 'Author', type: 'text' },
      ],
    },
  ],
  adminPages: [
    {
      id: 'books',
      title: 'Books',
      navLabel: 'Books',
      content: { kind: 'resource', heading: 'Books', resource: 'books' },
    },
  ],
}

describe('CMS plugin resource handlers', () => {
  it('requires an admin session for plugin record access', async () => {
    const res = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins/acme.books/resources/books/records'),
      makeFakeDb(),
    )

    expect(res.status).toBe(401)
  })

  it('creates, lists, updates, and deletes backend records for an enabled plugin resource', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)

    const install = await handleCmsRequest(cmsRequest('http://localhost/admin/api/cms/plugins', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: booksPlugin, grantedPermissions: booksPlugin.permissions }),
    }), db)
    expect(install.status).toBe(201)

    const create = await handleCmsRequest(cmsRequest(
      'http://localhost/admin/api/cms/plugins/acme.books/resources/books/records',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ data: { title: 'Invisible Cities', author: 'Italo Calvino', ignored: 'drop' } }),
      },
    ), db)
    expect(create.status).toBe(201)
    const createdBody = await create.json() as { record: { id: string; data: Record<string, unknown> } }
    expect(createdBody.record.data).toEqual({ title: 'Invisible Cities', author: 'Italo Calvino' })

    const list = await handleCmsRequest(cmsRequest(
      'http://localhost/admin/api/cms/plugins/acme.books/resources/books/records',
      { headers: { cookie } },
    ), db)
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      resource: { id: 'books', title: 'Books' },
      records: [{ data: { title: 'Invisible Cities' } }],
    })

    const update = await handleCmsRequest(cmsRequest(
      `http://localhost/admin/api/cms/plugins/acme.books/resources/books/records/${createdBody.record.id}`,
      {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ data: { title: 'The Left Hand of Darkness' } }),
      },
    ), db)
    expect(update.status).toBe(200)
    expect(await update.json()).toMatchObject({
      record: { data: { title: 'The Left Hand of Darkness' } },
    })

    const remove = await handleCmsRequest(cmsRequest(
      `http://localhost/admin/api/cms/plugins/acme.books/resources/books/records/${createdBody.record.id}`,
      { method: 'DELETE', headers: { cookie } },
    ), db)
    expect(remove.status).toBe(200)
    expect(await remove.json()).toEqual({ ok: true })
    expect(db.records).toHaveLength(0)
  })

  it('rejects records that do not match the plugin resource schema', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)

    await handleCmsRequest(cmsRequest('http://localhost/admin/api/cms/plugins', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: booksPlugin, grantedPermissions: booksPlugin.permissions }),
    }), db)

    const res = await handleCmsRequest(cmsRequest(
      'http://localhost/admin/api/cms/plugins/acme.books/resources/books/records',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ data: { author: 'Missing title' } }),
      },
    ), db)

    expect(res.status).toBe(400)
    expect(db.records).toHaveLength(0)
  })
})
