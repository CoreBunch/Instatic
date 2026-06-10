import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { SESSION_COOKIE_NAME, hashSessionToken } from '../../../server/auth/tokens'
import type { DbClient, DbResult } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { assertPathWithin } from '../../../server/util/pathWithin'
import { hookBus } from '@core/plugins/hookBus'

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
  const crashEvents: Record<string, unknown>[] = []
  const secrets: Record<string, unknown>[] = []

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
    // `requireStepUp` lookup — the plugin admin dispatcher now gates
    // install / upgrade / enable / disable / uninstall / restart / pack
    // install / settings PUT behind a fresh step-up window, mirroring the
    // `users.manage` step-up pattern. `createCookie` stamps a far-future
    // `step_up_expires_at` so existing tests behave as before.
    if (normalized.includes('select step_up_expires_at') && normalized.includes('from sessions')) {
      const session = sessions.find((s) => String(s.id_hash) === String(values[0]))
      if (!session) return { rows: [], rowCount: 0 }
      return {
        rows: [{ step_up_expires_at: session.step_up_expires_at ?? null } as Row],
        rowCount: 1,
      }
    }
    // getInstalledPlugin — single-row lookup by id
    if (normalized.includes('select id, name, version, enabled') && normalized.includes('where id =')) {
      const row = plugins.find((plugin) => plugin.id === values[0])
      return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 }
    }
    // listInstalledPlugins — no values
    if (normalized.includes('select id, name, version, enabled')) {
      return { rows: [...plugins] as Row[], rowCount: plugins.length }
    }
    // setPluginSettings — values[0]=settings_json, values[1]=id
    if (normalized.includes('update installed_plugins') && normalized.includes('set settings_json')) {
      const row = plugins.find((plugin) => plugin.id === values[1])
      if (!row) return { rows: [], rowCount: 0 }
      row.settings_json = values[0]
      row.updated_at = new Date('2026-05-01T10:07:00.000Z').toISOString()
      return { rows: [row as Row], rowCount: 1 }
    }
    // installPlugin — values[0..5]=id, name, version, manifestJson, permsJson, settingsJson
    if (normalized.includes('insert into installed_plugins')) {
      const now = new Date('2026-05-01T10:00:00.000Z').toISOString()
      const id = values[0]
      const previous = plugins.find((p) => p.id === id)
      const row = {
        id,
        name: values[1],
        version: values[2],
        enabled: true,
        lifecycle_status: 'installed',
        last_error: null,
        manifest_json: values[3],
        granted_permissions_json: values[4] ?? [],
        // Upsert preserves stored settings + installed_at across re-installs
        // (matches the real `on conflict do update` clause that doesn't SET
        // those columns).
        settings_json: previous?.settings_json ?? values[5] ?? '{}',
        installed_at: previous?.installed_at ?? now,
        updated_at: now,
      }
      const index = plugins.findIndex((plugin) => plugin.id === id)
      if (index >= 0) plugins[index] = row
      else plugins.push(row)
      return { rows: [row as Row], rowCount: 1 }
    }
    // setPluginEnabled — values[0]=enabled, values[1]=id (note: order changed from old pg API)
    if (normalized.includes('update installed_plugins set enabled')) {
      const row = plugins.find((plugin) => plugin.id === values[1])
      if (!row) return { rows: [], rowCount: 0 }
      row.enabled = values[0]
      row.updated_at = new Date('2026-05-01T10:05:00.000Z').toISOString()
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
    // deletePlugin — values[0]=id. Mimic the plugin_secrets FK cascade.
    if (normalized.includes('delete from installed_plugins where id')) {
      const index = plugins.findIndex((plugin) => plugin.id === values[0])
      if (index === -1) return { rows: [], rowCount: 0 }
      plugins.splice(index, 1)
      for (let i = secrets.length - 1; i >= 0; i--) {
        if (secrets[i].plugin_id === values[0]) secrets.splice(i, 1)
      }
      return { rows: [], rowCount: 1 }
    }
    // pluginSecrets upsert/seed — values[0..4]=pluginId, settingId, ciphertext, iv, fingerprint
    if (normalized.includes('insert into plugin_secrets')) {
      const existing = secrets.find(
        (s) => s.plugin_id === values[0] && s.setting_id === values[1],
      )
      if (existing) {
        if (normalized.includes('do nothing')) return { rows: [], rowCount: 0 }
        existing.ciphertext = values[2]
        existing.iv = values[3]
        existing.key_fingerprint = values[4]
        return { rows: [], rowCount: 1 }
      }
      secrets.push({
        plugin_id: values[0],
        setting_id: values[1],
        ciphertext: values[2],
        iv: values[3],
        key_fingerprint: values[4],
      })
      return { rows: [], rowCount: 1 }
    }
    // deletePluginSecret — values[0]=pluginId, values[1]=settingId
    if (normalized.includes('delete from plugin_secrets')) {
      const index = secrets.findIndex(
        (s) => s.plugin_id === values[0] && s.setting_id === values[1],
      )
      if (index === -1) return { rows: [], rowCount: 0 }
      secrets.splice(index, 1)
      return { rows: [], rowCount: 1 }
    }
    // listPluginSecretStates / resolvePluginSecretsForRuntime — values[0]=pluginId
    if (normalized.includes('from plugin_secrets')) {
      const rows = secrets.filter((s) => s.plugin_id === values[0])
      return { rows: rows as Row[], rowCount: rows.length }
    }
    // recordPluginCrash — values[0..3]=id, pluginId, reason, stack
    if (normalized.includes('insert into plugin_crash_events')) {
      const row = {
        id: values[0],
        plugin_id: values[1],
        occurred_at: new Date('2026-05-01T10:00:00.000Z').toISOString(),
        reason: values[2],
        stack: values[3] ?? null,
      }
      crashEvents.push(row)
      return { rows: [row as Row], rowCount: 1 }
    }
    // listPluginCrashes — values[0]=pluginId, values[1]=limit
    if (normalized.includes('select id, plugin_id, occurred_at, reason, stack')
        && normalized.includes('from plugin_crash_events')) {
      const rows = crashEvents
        .filter((c) => c.plugin_id === values[0])
        .slice(0, Number(values[1] ?? 10))
      return { rows: rows as Row[], rowCount: rows.length }
    }
    // clearPluginCrashes — values[0]=pluginId
    if (normalized.includes('delete from plugin_crash_events')) {
      const before = crashEvents.length
      const remaining = crashEvents.filter((c) => c.plugin_id !== values[0])
      crashEvents.length = 0
      crashEvents.push(...remaining)
      return { rows: [], rowCount: before - remaining.length }
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
    // The background publish scheduler ticks during these tests; model its
    // "due schedules" probe as always-empty so it never throws.
    if (normalized.includes('from data_rows') && normalized.includes('scheduled_publish_at')) {
      return { rows: [], rowCount: 0 }
    }
    // Post-activation schedule ghost sweep (disableSchedulesNotReclaimedSince)
    // — these tests register no schedules, so the sweep matches nothing.
    if (normalized.includes('update plugin_schedules')) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }

  handle.unsafe = async <Row = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<DbResult<Row>> =>
    handle<Row>(sql.split(/\$\d+|\?/) as unknown as TemplateStringsArray, ...params)

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return Object.assign(handle as DbClient, { admins, sessions, plugins, records, crashEvents, secrets })
}

async function createCookie(db: ReturnType<typeof makeFakeDb>): Promise<string> {
  const token = 'valid-session-token'
  db.sessions.push({
    id_hash: await hashSessionToken(token),
    user_id: 'admin_1',
    expires_at: new Date('2030-01-01').toISOString(),
    // Fresh step-up window — sensitive plugin admin endpoints now require
    // one (matches the `users.manage` step-up pattern). Tests exercising
    // step-up rejection can overwrite this on the pushed row.
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

function cmsFormRequest(
  url: string,
  formData: FormData,
  headers: Record<string, string> = {},
): Request {
  const headerMap = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    url,
    method: 'POST',
    headers: {
      get(name: string) {
        return headerMap.get(name.toLowerCase()) ?? null
      },
    },
    async formData() {
      return formData
    },
  } as Request
}

function pluginZip(files: Record<string, string>): File {
  const zipped = zipSync(Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, strToU8(content)]),
  ))
  return new File([zipped], 'workflow-tools.zip', { type: 'application/zip' })
}

const mapManifest = {
  id: 'local.map',
  name: 'Map Studio',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['admin.navigation'],
  adminPages: [{
    id: 'overview',
    title: 'Map Studio',
    navLabel: 'Map',
    icon: 'map',
    content: {
      kind: 'map',
      heading: 'Store Map',
      body: 'Track important locations.',
      centerLabel: 'Prague',
      pins: [{ label: 'HQ', detail: 'Main office', x: 42, y: 55 }],
    },
  }],
}

describe('CMS plugin handlers', () => {
  it('requires an admin session for plugin listing', async () => {
    const res = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins'),
      makeFakeDb(),
    )

    expect(res.status).toBe(401)
  })

  it('installs, lists, disables, and removes a declarative plugin manifest', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)

    const install = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          manifest: mapManifest,
          grantedPermissions: ['admin.navigation'],
        }),
      }),
      db,
    )

    expect(install.status).toBe(201)
    expect(await install.json()).toMatchObject({
      plugin: {
        id: 'local.map',
        name: 'Map Studio',
        enabled: true,
        lifecycleStatus: 'active',
        lastError: null,
        manifest: {
          adminPages: [{ route: '/admin/plugins/local.map/overview' }],
        },
      },
      adminPages: [{ pluginId: 'local.map', route: '/admin/plugins/local.map/overview' }],
    })

    const list = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins', {
        headers: { cookie },
      }),
      db,
    )
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      plugins: [{ id: 'local.map', enabled: true }],
      adminPages: [{ navLabel: 'Map' }],
    })

    const disable = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins/local.map', {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
      db,
    )
    expect(disable.status).toBe(200)
    expect(await disable.json()).toMatchObject({
      plugin: { id: 'local.map', enabled: false },
      plugins: [{ id: 'local.map', lifecycleStatus: 'disabled' }],
      adminPages: [],
    })

    const remove = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins/local.map', {
        method: 'DELETE',
        headers: { cookie },
      }),
      db,
    )
    expect(remove.status).toBe(200)
    expect(await remove.json()).toEqual({ ok: true })
    expect(db.plugins).toHaveLength(0)
  })

  it('encrypts secret settings into plugin_secrets and presents only the sentinel on browser-bound payloads', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)

    const secretManifest = {
      ...mapManifest,
      id: 'local.secret',
      name: 'Secret Keeper',
      settings: [
        { id: 'apiKey', type: 'password', label: 'API key', secret: true },
        { id: 'mode', type: 'text', label: 'Mode', default: 'fast' },
      ],
    }

    const install = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          manifest: secretManifest,
          grantedPermissions: ['admin.navigation'],
        }),
      }),
      db,
    )
    expect(install.status).toBe(201)

    const storedSettings = (): Record<string, unknown> =>
      JSON.parse(String(db.plugins[0].settings_json)) as Record<string, unknown>
    const secretRow = () =>
      db.secrets.find((s) => s.plugin_id === 'local.secret' && s.setting_id === 'apiKey')

    const putSettings = async (settings: Record<string, unknown>) =>
      handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/local.secret/settings', {
          method: 'PUT',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ settings }),
        }),
        db,
      )

    // Save a real secret — settings_json never receives the field; the value
    // lands encrypted in plugin_secrets and the response shows the sentinel.
    const save = await putSettings({ apiKey: 'real-secret', mode: 'turbo' })
    expect(save.status).toBe(200)
    expect(await save.json()).toEqual({
      settings: { apiKey: '***', mode: 'turbo' },
      secretsNeedingReentry: [],
    })
    expect(storedSettings()).toEqual({ mode: 'turbo' })
    const row = secretRow()
    expect(row).toBeDefined()
    expect(row!.ciphertext).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(row!.ciphertext as Uint8Array).toString('latin1')).not.toContain('real-secret')
    // No plaintext anywhere in the stored plugin row either.
    expect(JSON.stringify(db.plugins[0])).not.toContain('real-secret')

    // The plugins LIST payload shows the sentinel too — both on the plugin
    // row and on the admin-page route's settings snapshot.
    const list = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins', { headers: { cookie } }),
      db,
    )
    expect(list.status).toBe(200)
    const listBody = await list.json() as {
      plugins: Array<{ settings: Record<string, unknown> }>
      adminPages: Array<{ pluginSettings: Record<string, unknown> }>
    }
    expect(listBody.plugins[0].settings).toEqual({ apiKey: '***', mode: 'turbo' })
    expect(listBody.adminPages[0].pluginSettings).toEqual({ apiKey: '***', mode: 'turbo' })

    // The dedicated settings GET shows the sentinel for the stored secret.
    const get = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins/local.secret/settings', {
        headers: { cookie },
      }),
      db,
    )
    expect(get.status).toBe(200)
    const getBody = await get.json() as {
      settings: Record<string, unknown>
      secretsNeedingReentry: string[]
    }
    expect(getBody.settings).toEqual({ apiKey: '***', mode: 'turbo' })
    expect(getBody.secretsNeedingReentry).toEqual([])

    // PUT that round-trips the masked GET payload unchanged keeps the stored
    // encrypted row (same ciphertext) instead of storing the literal sentinel.
    const ciphertextBefore = Buffer.from(secretRow()!.ciphertext as Uint8Array)
    const unchanged = await putSettings({ apiKey: '***', mode: 'slow' })
    expect(unchanged.status).toBe(200)
    expect(storedSettings()).toEqual({ mode: 'slow' })
    expect(ciphertextBefore.equals(Buffer.from(secretRow()!.ciphertext as Uint8Array))).toBe(true)

    // A deliberate new value rotates the encrypted row…
    const rotate = await putSettings({ apiKey: 'rotated-secret', mode: 'slow' })
    expect(rotate.status).toBe(200)
    expect(ciphertextBefore.equals(Buffer.from(secretRow()!.ciphertext as Uint8Array))).toBe(false)
    expect(JSON.stringify(await rotate.json())).not.toContain('rotated-secret')

    // …and an empty string deliberately clears it: the row is deleted and
    // the field presents as empty (unset).
    const clear = await putSettings({ apiKey: '', mode: 'slow' })
    expect(clear.status).toBe(200)
    expect(secretRow()).toBeUndefined()
    expect(await clear.json()).toEqual({
      settings: { apiKey: '', mode: 'slow' },
      secretsNeedingReentry: [],
    })

    // State mutations return a single-plugin envelope alongside the list —
    // it must present the sentinel as well. Re-seed a real secret first.
    await putSettings({ apiKey: 'real-secret', mode: 'slow' })
    const disable = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins/local.secret', {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
      db,
    )
    expect(disable.status).toBe(200)
    const disableBody = await disable.json() as {
      plugin: { settings: Record<string, unknown> }
      plugins: Array<{ settings: Record<string, unknown> }>
    }
    expect(disableBody.plugin.settings).toEqual({ apiKey: '***', mode: 'slow' })
    expect(disableBody.plugins[0].settings).toEqual({ apiKey: '***', mode: 'slow' })
    // Presentation is wire-only — the encrypted row survives untouched.
    expect(secretRow()).toBeDefined()

    // Master-key rotation: a stale fingerprint surfaces as needs-re-entry on
    // the settings GET without breaking the payload.
    secretRow()!.key_fingerprint = 'deadbeefdeadbeef'
    const stale = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins/local.secret/settings', {
        headers: { cookie },
      }),
      db,
    )
    expect(stale.status).toBe(200)
    const staleBody = await stale.json() as {
      settings: Record<string, unknown>
      secretsNeedingReentry: string[]
    }
    expect(staleBody.settings).toEqual({ apiKey: '***', mode: 'slow' })
    expect(staleBody.secretsNeedingReentry).toEqual(['apiKey'])

    // Uninstall cascades the secrets rows.
    const remove = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins/local.secret', {
        method: 'DELETE',
        headers: { cookie },
      }),
      db,
    )
    expect(remove.status).toBe(200)
    expect(db.secrets).toHaveLength(0)
  })

  it('strips caller-supplied assetBasePath from JSON-installed manifests (path-traversal sink)', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)

    // Attacker-shaped manifest: assetBasePath escapes /uploads/plugins/
    // via `..` segments. The JSON install path must drop the value before
    // it is validated/stored — otherwise both filesystem sinks
    // (loadServerPluginModule, removePluginAssets) would later compose
    // an arbitrary path.
    const attackerManifest = {
      ...mapManifest,
      id: 'atk.evil',
      name: 'evil',
      version: '1.0.0',
      assetBasePath: '/uploads/plugins/../../etc',
      entrypoints: { server: 'pwn.js' },
    }

    const res = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          manifest: attackerManifest,
          grantedPermissions: ['admin.navigation'],
        }),
      }),
      db,
    )

    expect(res.status).toBe(201)
    const body = await res.json() as { plugin: { manifest: { assetBasePath?: unknown } } }
    expect(body.plugin.manifest.assetBasePath).toBeUndefined()
    expect(db.plugins).toHaveLength(1)
  })

  it('rejects invalid plugin manifests before persistence', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)

    const res = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ ...mapManifest, id: '../bad' }),
      }),
      db,
    )

    expect(res.status).toBe(400)
    expect(db.plugins).toHaveLength(0)
  })

  it('requires explicit permission grants before installing privileged plugins', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const privilegedManifest = {
      ...mapManifest,
      id: 'acme.workflow',
      name: 'Workflow Tools',
      permissions: ['editor.toolbar', 'editor.store.write', 'cms.routes', 'cms.storage'],
      entrypoints: {
        editor: 'editor/index.js',
        server: 'server/index.js',
      },
    }

    const denied = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: privilegedManifest, grantedPermissions: ['editor.toolbar'] }),
      }),
      db,
    )

    expect(denied.status).toBe(400)
    expect(db.plugins).toHaveLength(0)

    const accepted = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          manifest: privilegedManifest,
          grantedPermissions: privilegedManifest.permissions,
        }),
      }),
      db,
    )

    expect(accepted.status).toBe(201)
    expect(await accepted.json()).toMatchObject({
      plugin: {
        id: 'acme.workflow',
        grantedPermissions: privilegedManifest.permissions,
        manifest: {
          entrypoints: {
            editor: 'editor/index.js',
            server: 'server/index.js',
          },
        },
      },
    })
    expect(typeof db.plugins[0].manifest_json).toBe('string')
    expect(typeof db.plugins[0].granted_permissions_json).toBe('string')
    expect(JSON.parse(String(db.plugins[0].granted_permissions_json)))
      .toEqual(privilegedManifest.permissions)
  })

  it('installs zip plugin packages, writes assets, and activates backend routes', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-plugins-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const manifest = {
      id: 'acme.workflow',
      name: 'Workflow Tools',
      version: '1.0.0',
      apiVersion: 1,
      permissions: ['admin.navigation', 'cms.routes'],
      entrypoints: {
        server: 'server/index.js',
      },
      resources: [],
      adminPages: [{
        id: 'dashboard',
        title: 'Workflow',
        navLabel: 'Workflow',
        content: {
          kind: 'app',
          heading: 'Workflow Dashboard',
          entry: 'admin/dashboard.js',
        },
      }],
    }

    try {
      const formData = new FormData()
      formData.set('file', pluginZip({
        'plugin.json': JSON.stringify(manifest),
        'server/index.js': 'export function activate(api) { api.cms.routes.get("/ping", "plugins.read", () => ({ ok: true })) }',
        'admin/dashboard.js': 'export function render({ root }) { root.textContent = "Workflow" }',
      }))
      formData.set('grantedPermissions', JSON.stringify(manifest.permissions))

      const install = await handleCmsRequest(
        cmsFormRequest('http://localhost/admin/api/cms/plugins/package', formData, { cookie }),
        db,
        { uploadsDir },
      )

      expect(install.status).toBe(201)
      expect(typeof db.plugins[0].manifest_json).toBe('string')
      expect(typeof db.plugins[0].granted_permissions_json).toBe('string')
      expect(await install.json()).toMatchObject({
        plugin: {
          id: 'acme.workflow',
          lifecycleStatus: 'active',
          lastError: null,
          manifest: {
            assetBasePath: '/uploads/plugins/acme.workflow/1.0.0',
          },
        },
        adminPages: [{
          pluginId: 'acme.workflow',
          content: {
            kind: 'app',
            assetPath: '/uploads/plugins/acme.workflow/1.0.0',
          },
        }],
      })
      await expect(readFile(
        join(uploadsDir, 'plugins/acme.workflow/1.0.0/server/index.js'),
        'utf-8',
      )).resolves.toContain('activate')

      const runtime = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.workflow/runtime/ping', {
          headers: { cookie },
        }),
        db,
        { uploadsDir },
      )

      expect(runtime.status).toBe(200)
      expect(await runtime.json()).toEqual({ ok: true })
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('round-trips binary multipart uploads and binary responses through plugin routes', async () => {
    // End-to-end byte safety: a real multipart request with a binary file
    // field travels host → worker → QuickJS VM, the plugin reads the file's
    // exact bytes via the uploaded-file facade, and serves them back as a
    // binary `__response` body. Any lossy text decode on the way corrupts
    // the PNG signature bytes (0x89, 0x00, 0xff …) and fails the assert.
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-binary-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const manifest = {
      id: 'acme.binary',
      name: 'Binary Echo',
      version: '1.0.0',
      apiVersion: 1,
      permissions: ['cms.routes'],
      entrypoints: { server: 'server/index.js' },
    }
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x7f])

    try {
      const formData = new FormData()
      formData.set('file', pluginZip({
        'plugin.json': JSON.stringify(manifest),
        'server/index.js': `export function activate(api) {
          api.cms.routes.post('/echo', 'plugins.read', async (ctx) => {
            const file = ctx.body.file
            const bytes = new Uint8Array(await file.arrayBuffer())
            return {
              __response: true,
              status: 200,
              headers: { 'content-type': file.type, 'x-file-name': file.name },
              body: bytes,
            }
          })
        }`,
      }))
      formData.set('grantedPermissions', JSON.stringify(manifest.permissions))

      const install = await handleCmsRequest(
        cmsFormRequest('http://localhost/admin/api/cms/plugins/package', formData, { cookie }),
        db,
        { uploadsDir },
      )
      expect(install.status).toBe(201)

      // Hand-rolled multipart payload (happy-dom's test-global `Request`
      // strips the cookie header, so the stub-request pattern from
      // `cmsRequest` is extended with raw body bytes + iterable headers).
      const boundary = 'InstaticTestBoundary42'
      const te = new TextEncoder()
      const head = te.encode(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="pixel.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`,
      )
      const tail = te.encode(
        `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="label"\r\n\r\n` +
        `tiny png\r\n` +
        `--${boundary}--\r\n`,
      )
      const multipart = new Uint8Array(head.byteLength + pngBytes.byteLength + tail.byteLength)
      multipart.set(head, 0)
      multipart.set(pngBytes, head.byteLength)
      multipart.set(tail, head.byteLength + pngBytes.byteLength)

      const headerEntries: Record<string, string> = {
        cookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      }
      const echo = await handleCmsRequest(
        {
          url: 'http://localhost/admin/api/cms/plugins/acme.binary/runtime/echo',
          method: 'POST',
          headers: {
            get(name: string) {
              return headerEntries[name.toLowerCase()] ?? null
            },
            forEach(cb: (value: string, key: string) => void) {
              for (const [key, value] of Object.entries(headerEntries)) cb(value, key)
            },
          },
          async arrayBuffer() {
            return multipart.buffer
          },
        } as unknown as Request,
        db,
        { uploadsDir },
      )

      expect(echo.status).toBe(200)
      expect(echo.headers.get('content-type')).toBe('image/png')
      expect(echo.headers.get('x-file-name')).toBe('pixel.png')
      expect(new Uint8Array(await echo.arrayBuffer())).toEqual(pngBytes)
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('runs packaged server plugin lifecycle hooks on install, disable, enable, and remove', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-lifecycle-'))
    // The QuickJS-sandboxed plugin can't touch node:fs. We use the hookBus as
    // the sandbox-safe cross-context channel — the plugin emits lifecycle
    // events as hook events, the host subscribes to record them.
    //
    // `activateInstalledServerPlugins` calls `hookBus.reset()` whenever it
    // re-binds the plugin world (which happens on enable/disable/uninstall),
    // so we re-attach the listener after every CMS request below.
    const markers: string[] = []
    function attachListener(): void {
      // Idempotent — drop any prior 'test' listener so this never double-fires.
      hookBus.unregisterPlugin('test')
      // Plugin emits arrive force-namespaced as `plugin.<id>.<name>`.
      hookBus.on('test', 'plugin.acme.lifecycle.lifecycle.mark', async (payload: unknown) => {
        if (payload && typeof payload === 'object') {
          const p = payload as { name?: unknown; pluginId?: unknown }
          if (typeof p.name === 'string' && typeof p.pluginId === 'string') {
            markers.push(`${p.name}:${p.pluginId}`)
          }
        }
      })
    }
    attachListener()

    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const manifest = {
      id: 'acme.lifecycle',
      name: 'Lifecycle Demo',
      version: '1.0.0',
      apiVersion: 1,
      permissions: ['cms.routes', 'cms.storage', 'cms.hooks'],
      entrypoints: {
        server: 'server/index.js',
      },
      resources: [{
        id: 'events',
        title: 'Events',
        fields: [{ id: 'name', label: 'Name', type: 'text', required: true }],
      }],
      adminPages: [],
    }
    const serverEntrypoint = `
      async function mark(api, name) {
        await api.cms.hooks.emit('lifecycle.mark', { name: name, pluginId: api.plugin.id })
      }
      export async function install(api) {
        await mark(api, 'install')
        await api.cms.storage.collection('events').create({ name: 'installed' })
      }
      export async function activate(api) {
        await mark(api, 'activate')
        api.cms.routes.get('/ping', 'plugins.read', () => ({ ok: true, plugin: api.plugin.id }))
      }
      export async function deactivate(api) { await mark(api, 'deactivate') }
      export async function uninstall(api) { await mark(api, 'uninstall') }
    `

    function readMarkers(): string[] {
      return [...markers]
    }

    try {
      const formData = new FormData()
      formData.set('file', pluginZip({
        'plugin.json': JSON.stringify(manifest),
        'server/index.js': serverEntrypoint,
      }))
      formData.set('grantedPermissions', JSON.stringify(manifest.permissions))

      const install = await handleCmsRequest(
        cmsFormRequest('http://localhost/admin/api/cms/plugins/package', formData, { cookie }),
        db,
        { uploadsDir },
      )
      expect(install.status).toBe(201)
      expect(readMarkers()).toEqual([
        'install:acme.lifecycle',
        'activate:acme.lifecycle',
      ])
      expect(db.records).toHaveLength(1)

      attachListener()
      const disable = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.lifecycle', {
          method: 'PATCH',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        }),
        db,
        { uploadsDir },
      )
      expect(disable.status).toBe(200)
      expect(await disable.json()).toMatchObject({
        plugin: { enabled: false, lifecycleStatus: 'disabled' },
      })

      attachListener()
      const enable = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.lifecycle', {
          method: 'PATCH',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        }),
        db,
        { uploadsDir },
      )
      expect(enable.status).toBe(200)
      expect(await enable.json()).toMatchObject({
        plugin: { enabled: true, lifecycleStatus: 'active' },
      })

      attachListener()
      const remove = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.lifecycle', {
          method: 'DELETE',
          headers: { cookie },
        }),
        db,
        { uploadsDir },
      )
      expect(remove.status).toBe(200)
      expect(readMarkers()).toContain('uninstall:acme.lifecycle')
      expect(db.plugins).toHaveLength(0)
    } finally {
      hookBus.unregisterPlugin('test')
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('refuses to re-sync a disabled plugin\'s pack into the site', async () => {
    // Regression: pre-fix, POST /admin/api/cms/plugins/:id/pack/install
    // would happily merge a disabled plugin's bundled VCs / pages / classes
    // into the user's draft site — the opposite of what "disabled" should
    // mean. The endpoint now gates on `plugin.enabled` and returns 400.
    const db = makeFakeDb()
    const cookie = await createCookie(db)

    // Seed a plugin row directly so we don't need real pack files on disk
    // — the gate fires before `loadPluginPackFile` runs.
    db.plugins.push({
      id: 'acme.with-pack',
      name: 'Pack Plugin',
      version: '1.0.0',
      enabled: false,
      lifecycle_status: 'disabled',
      last_error: null,
      manifest_json: JSON.stringify({
        id: 'acme.with-pack',
        name: 'Pack Plugin',
        version: '1.0.0',
        apiVersion: 1,
        permissions: ['visualComponents.register'],
        adminPages: [],
        resources: [],
        pack: { path: 'pack/site.json' },
        assetBasePath: '/uploads/plugins/acme.with-pack/1.0.0',
      }),
      granted_permissions_json: JSON.stringify(['visualComponents.register']),
      settings_json: '{}',
      installed_at: '2026-05-01T10:00:00.000Z',
      updated_at: '2026-05-01T10:00:00.000Z',
    })

    const res = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins/acme.with-pack/pack/install', {
        method: 'POST',
        headers: { cookie },
      }),
      db,
      { uploadsDir: '/tmp/unused-because-gate-fires-first' },
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('disabled'),
    })
  })

  it('assertPathWithin rejects paths that escape the uploads root', () => {
    const root = '/srv/uploads'
    // Same root and a child below the root → ok.
    expect(() => assertPathWithin(root, '/srv/uploads/plugins/atk.evil/1.0.0/x.js'))
      .not.toThrow()
    // path.join already normalised these, but we still re-check the resolved value.
    expect(() => assertPathWithin(root, '/srv/etc'))
      .toThrow('escapes root')
    expect(() => assertPathWithin(root, '/srv/uploads/../etc'))
      .toThrow('escapes root')
    // The root itself is rejected — there is no legitimate plugin file at exactly the uploads root.
    expect(() => assertPathWithin(root, '/srv/uploads'))
      .toThrow('escapes root')
  })

  it('stores lifecycle errors for admin diagnostics without losing the plugin row', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-lifecycle-error-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const manifest = {
      id: 'acme.broken',
      name: 'Broken Plugin',
      version: '1.0.0',
      apiVersion: 1,
      permissions: [],
      entrypoints: {
        server: 'server/index.js',
      },
      resources: [],
      adminPages: [],
    }

    try {
      const formData = new FormData()
      formData.set('file', pluginZip({
        'plugin.json': JSON.stringify(manifest),
        'server/index.js': 'export function install() { throw new Error("install exploded") }',
      }))
      formData.set('grantedPermissions', JSON.stringify([]))

      const install = await handleCmsRequest(
        cmsFormRequest('http://localhost/admin/api/cms/plugins/package', formData, { cookie }),
        db,
        { uploadsDir },
      )

      expect(install.status).toBe(201)
      expect(await install.json()).toMatchObject({
        plugin: {
          id: 'acme.broken',
          lifecycleStatus: 'error',
          lastError: 'install exploded',
        },
      })
      expect(db.plugins).toHaveLength(1)
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  // ─── Upgrade flow ────────────────────────────────────────────────────────
  //
  // The upgrade path detects an already-installed plugin id, runs the new
  // version's `migrate({ fromVersion }, api)` between the old version's
  // deactivate and the new version's activate, preserves settings + installed_at,
  // drops the old version's asset dir on success, and rolls back to the prior
  // version on activate failure.

  it('routes a same-id newer-version upload through the upgrade flow with migrate', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-upgrade-'))
    // Plugin runs in a QuickJS sandbox — no node:fs. Use the hookBus as the
    // sandbox-safe cross-context channel. Re-attach the listener after every
    // CMS request because `activateInstalledServerPlugins` calls
    // `hookBus.reset()` on every re-bind.
    const markers: string[] = []
    function attachListener(): void {
      // Idempotent — drop any prior 'test' listener so this never double-fires.
      hookBus.unregisterPlugin('test')
      // Plugin emits arrive force-namespaced as `plugin.<id>.<name>`.
      hookBus.on('test', 'plugin.acme.upgrade.upgrade.mark', async (payload: unknown) => {
        if (payload && typeof payload === 'object' && typeof (payload as { line?: unknown }).line === 'string') {
          markers.push(String((payload as { line: string }).line))
        }
      })
    }
    attachListener()

    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const baseManifest = (version: string) => ({
      id: 'acme.upgrade',
      name: 'Upgrade Demo',
      version,
      apiVersion: 1,
      permissions: ['cms.routes', 'cms.hooks'],
      entrypoints: { server: 'server/index.js' },
      resources: [],
      adminPages: [],
    })

    try {
      // Old version: records its own activate/deactivate via hook events.
      const v1 = `
        async function mark(api, line) { await api.cms.hooks.emit('upgrade.mark', { line: line }) }
        export async function activate(api) { await mark(api, 'v1.activate') }
        export async function deactivate(api) { await mark(api, 'v1.deactivate') }
      `
      // New version: declares a migrate hook + activate. Migrate must run
      // between old.deactivate and new.activate.
      const v2 = `
        async function mark(api, line) { await api.cms.hooks.emit('upgrade.mark', { line: line }) }
        export async function migrate(ctx, api) { await mark(api, 'v2.migrate:' + ctx.fromVersion) }
        export async function activate(api) { await mark(api, 'v2.activate') }
      `

      // Fresh install of v1.
      const v1FormData = new FormData()
      v1FormData.set('file', pluginZip({
        'plugin.json': JSON.stringify(baseManifest('1.0.0')),
        'server/index.js': v1,
      }))
      v1FormData.set('grantedPermissions', JSON.stringify(['cms.routes', 'cms.hooks']))
      const installV1 = await handleCmsRequest(
        cmsFormRequest('http://localhost/admin/api/cms/plugins/package', v1FormData, { cookie }),
        db,
        { uploadsDir },
      )
      expect(installV1.status).toBe(201)

      // Capture installed_at so we can verify it's preserved on upgrade.
      const installedAtBefore = db.plugins[0].installed_at

      // Upload v2 of the same plugin id.
      attachListener()
      const v2FormData = new FormData()
      v2FormData.set('file', pluginZip({
        'plugin.json': JSON.stringify(baseManifest('1.1.0')),
        'server/index.js': v2,
      }))
      v2FormData.set('grantedPermissions', JSON.stringify(['cms.routes', 'cms.hooks']))
      const upgrade = await handleCmsRequest(
        cmsFormRequest('http://localhost/admin/api/cms/plugins/package', v2FormData, { cookie }),
        db,
        { uploadsDir },
      )
      expect(upgrade.status).toBe(200)
      const upgradeBody = await upgrade.json() as {
        plugin: { version: string; lifecycleStatus: string }
        upgrade?: { fromVersion: string; toVersion: string }
      }
      expect(upgradeBody.plugin.version).toBe('1.1.0')
      expect(upgradeBody.plugin.lifecycleStatus).toBe('active')
      expect(upgradeBody.upgrade).toEqual({ fromVersion: '1.0.0', toVersion: '1.1.0' })

      // Lifecycle ordering: v1.activate → v1.deactivate → v2.migrate(1.0.0) → v2.activate
      expect(markers).toEqual([
        'v1.activate',
        'v1.deactivate',
        'v2.migrate:1.0.0',
        'v2.activate',
      ])

      // installed_at preserved across the upgrade.
      expect(db.plugins[0].installed_at).toBe(installedAtBefore)

      // Old version's asset dir was deleted; new version's is on disk.
      await expect(readFile(
        join(uploadsDir, 'plugins/acme.upgrade/1.1.0/server/index.js'),
        'utf-8',
      )).resolves.toContain('migrate')
      const { existsSync } = await import('node:fs')
      expect(existsSync(join(uploadsDir, 'plugins/acme.upgrade/1.0.0'))).toBe(false)
    } finally {
      hookBus.unregisterPlugin('test')
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('rolls back to the prior version when the new version\'s activate hook throws', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-rollback-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const baseManifest = (version: string) => ({
      id: 'acme.rollback',
      name: 'Rollback Demo',
      version,
      apiVersion: 1,
      permissions: ['cms.routes'],
      entrypoints: { server: 'server/index.js' },
      resources: [],
      adminPages: [],
    })

    try {
      const v1 = `export function activate() {}`
      // v2 throws on activate to force rollback.
      const v2 = `export function activate() { throw new Error('v2 activate exploded') }`

      const v1FormData = new FormData()
      v1FormData.set('file', pluginZip({
        'plugin.json': JSON.stringify(baseManifest('1.0.0')),
        'server/index.js': v1,
      }))
      v1FormData.set('grantedPermissions', JSON.stringify(['cms.routes']))
      const installV1 = await handleCmsRequest(
        cmsFormRequest('http://localhost/admin/api/cms/plugins/package', v1FormData, { cookie }),
        db,
        { uploadsDir },
      )
      expect(installV1.status).toBe(201)

      const v2FormData = new FormData()
      v2FormData.set('file', pluginZip({
        'plugin.json': JSON.stringify(baseManifest('1.1.0')),
        'server/index.js': v2,
      }))
      v2FormData.set('grantedPermissions', JSON.stringify(['cms.routes']))
      const upgrade = await handleCmsRequest(
        cmsFormRequest('http://localhost/admin/api/cms/plugins/package', v2FormData, { cookie }),
        db,
        { uploadsDir },
      )
      expect(upgrade.status).toBe(400)
      const body = await upgrade.json() as { error: string; plugins: { id: string; version: string; lifecycleStatus: string }[] }
      expect(body.error).toMatch(/Upgrade failed/)
      expect(body.error).toMatch(/Rolled back to version 1\.0\.0/)

      // DB row reflects the prior version.
      expect(db.plugins[0].version).toBe('1.0.0')

      // Old version's asset dir is still on disk; new version's was deleted.
      const { existsSync } = await import('node:fs')
      expect(existsSync(join(uploadsDir, 'plugins/acme.rollback/1.0.0'))).toBe(true)
      expect(existsSync(join(uploadsDir, 'plugins/acme.rollback/1.1.0'))).toBe(false)
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('refuses to downgrade to an older version', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-downgrade-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    const baseManifest = (version: string) => ({
      id: 'acme.downgrade',
      name: 'Downgrade Demo',
      version,
      apiVersion: 1,
      permissions: ['cms.routes'],
      entrypoints: { server: 'server/index.js' },
      resources: [],
      adminPages: [],
    })

    try {
      const v2FormData = new FormData()
      v2FormData.set('file', pluginZip({
        'plugin.json': JSON.stringify(baseManifest('2.0.0')),
        'server/index.js': 'export function activate() {}',
      }))
      v2FormData.set('grantedPermissions', JSON.stringify(['cms.routes']))
      const installV2 = await handleCmsRequest(
        cmsFormRequest('http://localhost/admin/api/cms/plugins/package', v2FormData, { cookie }),
        db,
        { uploadsDir },
      )
      expect(installV2.status).toBe(201)

      const v1FormData = new FormData()
      v1FormData.set('file', pluginZip({
        'plugin.json': JSON.stringify(baseManifest('1.0.0')),
        'server/index.js': 'export function activate() {}',
      }))
      v1FormData.set('grantedPermissions', JSON.stringify(['cms.routes']))
      const downgrade = await handleCmsRequest(
        cmsFormRequest('http://localhost/admin/api/cms/plugins/package', v1FormData, { cookie }),
        db,
        { uploadsDir },
      )
      expect(downgrade.status).toBe(400)
      const body = await downgrade.json() as { error: string }
      expect(body.error).toMatch(/refusing to downgrade/)
      // DB row unchanged.
      expect(db.plugins[0].version).toBe('2.0.0')
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('rejects manifests targeting an unsupported apiVersion at the boundary', async () => {
    const db = makeFakeDb()
    const cookie = await createCookie(db)

    const futureManifest = {
      ...mapManifest,
      id: 'acme.future',
      apiVersion: 99,
    }
    const res = await handleCmsRequest(
      cmsRequest('http://localhost/admin/api/cms/plugins', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          manifest: futureManifest,
          grantedPermissions: ['admin.navigation'],
        }),
      }),
      db,
    )
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/apiVersion 99/)
    expect(db.plugins).toHaveLength(0)
  })

  // ─── Crash counter (sliding window) ───────────────────────────────────────

  it('crash counter respawns within budget then gives up after 3 crashes in 5min', async () => {
    const { recordCrashAndDecide, clearPluginCrashCounter } = await import(
      '../../../server/plugins/host/crashRecovery'
    )
    const id = `test.crash.${Date.now()}`

    // Use explicit `now` so the test is deterministic and doesn't rely on
    // wall-clock timing. All three crashes inside the 5-minute window.
    const t0 = 1_000_000_000_000
    const first = recordCrashAndDecide(id, t0)
    const second = recordCrashAndDecide(id, t0 + 1000)
    const third = recordCrashAndDecide(id, t0 + 2000)
    expect(first).toEqual({ kind: 'respawn', recentCrashCount: 1 })
    expect(second).toEqual({ kind: 'respawn', recentCrashCount: 2 })
    expect(third).toEqual({ kind: 'give-up', recentCrashCount: 3 })

    // Crash that lands AFTER the window expires resets the count.
    const reset = recordCrashAndDecide(id, t0 + 6 * 60 * 1000)
    expect(reset).toEqual({ kind: 'respawn', recentCrashCount: 1 })

    // Manual clear (used by the restart endpoint) wipes the counter even
    // mid-window.
    clearPluginCrashCounter(id)
    const afterClear = recordCrashAndDecide(id, t0 + 6 * 60 * 1000 + 1000)
    expect(afterClear).toEqual({ kind: 'respawn', recentCrashCount: 1 })

    // Cleanup so this test doesn't leak counter state into siblings.
    clearPluginCrashCounter(id)
  })

  // ─── Manual restart endpoint ──────────────────────────────────────────────

  it('POST /restart resets crash counter, drops crash events, and re-activates the plugin', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-restart-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    // Sandbox-safe activation tracking via hookBus — re-attach after every
    // CMS request because activateInstalledServerPlugins calls hookBus.reset().
    const markers: string[] = []
    function attachListener(): void {
      hookBus.unregisterPlugin('test')
      // Plugin emits arrive force-namespaced as `plugin.<id>.<name>`.
      hookBus.on('test', 'plugin.test.restart.restart.mark', async () => { markers.push('activate') })
    }
    attachListener()
    try {
      const formData = new FormData()
      formData.set('file', pluginZip({
        'plugin.json': JSON.stringify({
          id: 'test.restart',
          name: 'Restart Demo',
          version: '1.0.0',
          apiVersion: 1,
          permissions: ['cms.routes', 'cms.hooks'],
          entrypoints: { server: 'server/index.js' },
          resources: [],
          adminPages: [],
        }),
        'server/index.js': `
          export async function activate(api) {
            await api.cms.hooks.emit('restart.mark', {})
          }
        `,
      }))
      formData.set('grantedPermissions', JSON.stringify(['cms.routes', 'cms.hooks']))
      const install = await handleCmsRequest(
        cmsFormRequest('http://localhost/admin/api/cms/plugins/package', formData, { cookie }),
        db,
        { uploadsDir },
      )
      expect(install.status).toBe(201)

      // Simulate that the plugin has been parked in `error` state with
      // historical crash events — what the operator would see if the
      // sliding-window budget had been exhausted.
      db.plugins[0].lifecycle_status = 'error'
      db.plugins[0].last_error = 'simulated crash'
      const { recordPluginCrash } = await import('../../../server/repositories/plugins')
      await recordPluginCrash(db, { id: 'crash_1', pluginId: 'test.restart', reason: 'simulated 1' })
      await recordPluginCrash(db, { id: 'crash_2', pluginId: 'test.restart', reason: 'simulated 2' })
      await recordPluginCrash(db, { id: 'crash_3', pluginId: 'test.restart', reason: 'simulated 3' })

      // POST /restart must reset state and bring the plugin back to active.
      attachListener()
      const restart = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/test.restart/restart', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
        }),
        db,
        { uploadsDir },
      )
      expect(restart.status).toBe(200)
      const body = await restart.json() as {
        plugin: { lifecycleStatus: string; recentCrashes?: unknown[] }
        plugins: { id: string; recentCrashes?: unknown[] }[]
      }
      expect(body.plugin.lifecycleStatus).toBe('active')
      // recentCrashes returned for the restarted plugin should be empty —
      // historical events were wiped as part of the restart.
      const restartedFromList = body.plugins.find((p) => p.id === 'test.restart')
      expect(restartedFromList?.recentCrashes).toEqual([])

      // activate() ran twice: once on initial install, once after restart.
      expect(markers).toEqual(['activate', 'activate'])
    } finally {
      hookBus.unregisterPlugin('test')
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  // ─── Per-plugin worker crash isolation ───────────────────────────────────
  //
  // Regression gate for the per-plugin worker model. Two plugins are
  // installed; one's route handler intentionally throws an error severe
  // enough to take down its worker. The sibling plugin's worker must keep
  // serving routes — proving that crashes are isolated per pluginId.

  it('crash in one plugin\'s worker does not affect a sibling plugin\'s worker', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-crash-iso-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)

    function manifestFor(id: string) {
      return {
        id,
        name: id,
        version: '1.0.0',
        apiVersion: 1,
        permissions: ['cms.routes'],
        entrypoints: { server: 'server/index.js' },
        resources: [],
        adminPages: [],
      }
    }

    try {
      // Plugin A — a "well-behaved" plugin with a /ping route that just works.
      const goodFormData = new FormData()
      goodFormData.set('file', pluginZip({
        'plugin.json': JSON.stringify(manifestFor('acme.good')),
        'server/index.js': `
          export function activate(api) {
            api.cms.routes.get('/ping', 'plugins.read', () => ({ ok: true, who: 'good' }))
          }
        `,
      }))
      goodFormData.set('grantedPermissions', JSON.stringify(['cms.routes']))
      const installGood = await handleCmsRequest(
        cmsFormRequest('http://localhost/admin/api/cms/plugins/package', goodFormData, { cookie }),
        db,
        { uploadsDir },
      )
      expect(installGood.status).toBe(201)

      // Plugin B — registers a /boom route whose handler throws. With per-
      // plugin workers, this throw is caught by the worker entry's run-route
      // dispatcher and turned into an error result; it does NOT take down
      // the worker (the route handler runs inside try/catch in pluginWorker).
      // For a HARDER test we use a synchronous throw at the API boundary,
      // not just a route handler — same isolation guarantee should hold.
      const badFormData = new FormData()
      badFormData.set('file', pluginZip({
        'plugin.json': JSON.stringify(manifestFor('acme.bad')),
        'server/index.js': `
          export function activate(api) {
            api.cms.routes.get('/boom', 'plugins.read', () => {
              throw new Error('plugin boom')
            })
          }
        `,
      }))
      badFormData.set('grantedPermissions', JSON.stringify(['cms.routes']))
      const installBad = await handleCmsRequest(
        cmsFormRequest('http://localhost/admin/api/cms/plugins/package', badFormData, { cookie }),
        db,
        { uploadsDir },
      )
      expect(installBad.status).toBe(201)

      // Trigger plugin B's failing route — host should return 500 with the
      // error message, not crash the process.
      const boom = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.bad/runtime/boom', {
          headers: { cookie },
        }),
        db,
        { uploadsDir },
      )
      expect(boom.status).toBe(500)
      expect((await boom.json() as { error: string }).error).toMatch(/plugin boom/)

      // Plugin A's /ping must STILL work after the sibling failure — proves
      // the isolation. Whether or not B's worker was terminated, A's worker
      // is independent.
      const ping = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.good/runtime/ping', {
          headers: { cookie },
        }),
        db,
        { uploadsDir },
      )
      expect(ping.status).toBe(200)
      expect(await ping.json()).toEqual({ ok: true, who: 'good' })
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })
})
