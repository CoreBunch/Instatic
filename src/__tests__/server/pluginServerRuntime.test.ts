/**
 * Server plugin runtime — integration tests through the cms handler.
 *
 * Plugin server modules run in a Bun Worker (the host never imports them
 * directly), so these tests build real `.zip` packages and install them
 * via the cms handler, then verify behavior end-to-end:
 *  - public GET routes (`api.cms.routes.public.get`) don't require auth
 *  - missing capability grants block registration at the API boundary
 *  - plugin metadata (`api.plugin.id/version/permissions`) reaches the
 *    plugin's hooks
 *  - the host's lifecycle status reflects activate failures correctly
 *
 * Cross-context observation uses fs-marker files (the worker has its own
 * globalThis), same pattern the agent-browser e2e and `cmsPlugins.test.ts`
 * lifecycle test use.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { SESSION_COOKIE_NAME, hashSessionToken } from '../../../server/auth/tokens'
import type { DbClient, DbResult } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { loopSourceRegistry } from '@core/loops/registry'
import { hookBus } from '@core/plugins/hookBus'

function makeFakeDb() {
  const sessions: Record<string, unknown>[] = []
  const plugins: Record<string, unknown>[] = []
  const records: Record<string, unknown>[] = []
  const crashEvents: Record<string, unknown>[] = []

  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.includes('from sessions') && normalized.includes('join users')) {
      const session = sessions.find((s) => String(s.id_hash) === String(values[0]))
      if (!session) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          id: 'admin_1',
          email: 'owner@example.com',
          email_normalized: 'owner@example.com',
          display_name: 'Owner',
          password_hash: 'hash',
          status: 'active',
          role_id: 'owner',
          last_login_at: null,
          created_at: new Date('2026-05-01').toISOString(),
          updated_at: new Date('2026-05-01').toISOString(),
          deleted_at: null,
          role_slug: 'owner',
          role_name: 'Owner',
          role_description: '',
          role_is_system: true,
          role_capabilities_json: ['plugins.read', 'plugins.configure', 'plugins.install', 'plugins.lifecycle'],
        } as Row],
        rowCount: 1,
      }
    }
    if (normalized.includes('update sessions') && normalized.includes('last_seen_at')) {
      return { rows: [], rowCount: 1 }
    }
    // `requireStepUp` (now applied to sensitive plugin admin routes — install,
    // upgrade, enable/disable, uninstall, restart, pack install, settings
    // PUT) reads the active session's step-up expiry to enforce a fresh
    // password re-entry window. Mirror the production lookup by returning
    // the value stored on the in-memory session row; `createCookie` stamps a
    // far-future window so the existing tests behave as before.
    if (normalized.includes('select step_up_expires_at') && normalized.includes('from sessions')) {
      const session = sessions.find((s) => String(s.id_hash) === String(values[0]))
      if (!session) return { rows: [], rowCount: 0 }
      return {
        rows: [{ step_up_expires_at: session.step_up_expires_at ?? null } as Row],
        rowCount: 1,
      }
    }
    if (normalized.includes('insert into audit_events')) {
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('select id, name, version, enabled') && normalized.includes('where id =')) {
      const row = plugins.find((plugin) => plugin.id === values[0])
      return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.includes('select id, name, version, enabled')) {
      return { rows: [...plugins] as Row[], rowCount: plugins.length }
    }
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
        settings_json: previous?.settings_json ?? values[5] ?? '{}',
        installed_at: previous?.installed_at ?? now,
        updated_at: now,
      }
      const index = plugins.findIndex((plugin) => plugin.id === id)
      if (index >= 0) plugins[index] = row
      else plugins.push(row)
      return { rows: [row as Row], rowCount: 1 }
    }
    if (normalized.includes('update installed_plugins') && normalized.includes('set settings_json')) {
      const row = plugins.find((plugin) => plugin.id === values[1])
      if (!row) return { rows: [], rowCount: 0 }
      row.settings_json = values[0]
      row.updated_at = new Date().toISOString()
      return { rows: [row as Row], rowCount: 1 }
    }
    if (normalized.includes('update installed_plugins set lifecycle_status')) {
      const row = plugins.find((plugin) => plugin.id === values[2])
      if (!row) return { rows: [], rowCount: 0 }
      row.lifecycle_status = values[0]
      row.last_error = values[1] ?? null
      row.updated_at = new Date().toISOString()
      return { rows: [row as Row], rowCount: 1 }
    }
    if (normalized.includes('insert into plugin_crash_events')) {
      const row = {
        id: values[0],
        plugin_id: values[1],
        occurred_at: new Date().toISOString(),
        reason: values[2],
        stack: values[3] ?? null,
      }
      crashEvents.push(row)
      return { rows: [row as Row], rowCount: 1 }
    }
    if (normalized.includes('select id, plugin_id, occurred_at, reason, stack')
        && normalized.includes('from plugin_crash_events')) {
      const rows = crashEvents
        .filter((c) => c.plugin_id === values[0])
        .slice(0, Number(values[1] ?? 10))
      return { rows: rows as Row[], rowCount: rows.length }
    }
    if (normalized.includes('delete from plugin_crash_events')) {
      const before = crashEvents.length
      const remaining = crashEvents.filter((c) => c.plugin_id !== values[0])
      crashEvents.length = 0
      crashEvents.push(...remaining)
      return { rows: [], rowCount: before - remaining.length }
    }
    if (normalized.includes('insert into plugin_records')) {
      const row = {
        id: values[0],
        plugin_id: values[1],
        resource_id: values[2],
        data_json: values[3],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      records.push(row)
      return { rows: [row as Row], rowCount: 1 }
    }
    // Post-activation schedule ghost sweep (disableSchedulesNotReclaimedSince)
    // — these tests register no schedules, so the sweep matches nothing.
    if (normalized.includes('update plugin_schedules')) {
      return { rows: [], rowCount: 0 }
    }
    // listPluginSecretStates / resolvePluginSecretsForRuntime — these tests
    // declare no secret-typed settings, so the table is always empty.
    if (normalized.includes('from plugin_secrets')) {
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

  return Object.assign(handle as DbClient, { sessions, plugins, records })
}

async function createCookie(db: ReturnType<typeof makeFakeDb>): Promise<string> {
  const token = 'valid-session-token'
  db.sessions.push({
    id_hash: await hashSessionToken(token),
    user_id: 'admin_1',
    expires_at: new Date('2030-01-01').toISOString(),
    // Fresh step-up window — the plugin admin endpoints now require one
    // (matches the `users.manage` step-up pattern). Tests exercising
    // step-up-gated routes can override this by editing the row after
    // calling `createCookie`.
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
  return new File([zipped], 'plugin.zip', { type: 'application/zip' })
}

async function waitForLoopSource(sourceId: string): Promise<void> {
  const deadline = Date.now() + 500
  while (!loopSourceRegistry.has(sourceId)) {
    if (Date.now() > deadline) {
      throw new Error(`Loop source "${sourceId}" was not registered`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function installPlugin(args: {
  manifest: Record<string, unknown>
  serverEntrypoint: string
  grantedPermissions: string[]
  uploadsDir: string
  db: ReturnType<typeof makeFakeDb>
  cookie: string
}): Promise<Response> {
  const formData = new FormData()
  formData.set('file', pluginZip({
    'plugin.json': JSON.stringify(args.manifest),
    'server/index.js': args.serverEntrypoint,
  }))
  formData.set('grantedPermissions', JSON.stringify(args.grantedPermissions))
  return await handleCmsRequest(
    cmsFormRequest('http://localhost/admin/api/cms/plugins/package', formData, { cookie: args.cookie }),
    args.db,
    { uploadsDir: args.uploadsDir },
  )
}

const baseManifest = {
  id: 'acme.workflow',
  name: 'Workflow Tools',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['cms.routes'] as const,
  entrypoints: { server: 'server/index.js' },
  resources: [],
  adminPages: [],
}

describe('server plugin runtime SDK', () => {
  it('lets plugins explicitly register public GET routes (no auth required)', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-public-routes-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    try {
      const install = await installPlugin({
        manifest: baseManifest,
        serverEntrypoint: `
          export function activate(api) {
            api.cms.routes.public.get('/status', () => ({ ok: true, plugin: api.plugin.id }))
          }
        `,
        // Public-access routes require BOTH cms.routes (to register
        // anything) AND cms.routes.public (to allow the anonymous form).
        grantedPermissions: ['cms.routes', 'cms.routes.public'],
        uploadsDir,
        db,
        cookie,
      })
      expect(install.status).toBe(201)

      // Hit the runtime route WITHOUT a session cookie — public routes skip auth.
      const res = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.workflow/runtime/status'),
        db,
        { uploadsDir },
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, plugin: 'acme.workflow' })
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('blocks backend route registration without the cms.routes permission grant', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-perm-gate-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    try {
      // Plugin that requests cms.storage only, but tries to register a route
      // (which requires cms.routes). The activate hook should throw and the
      // host's lifecycle row should reflect lastError.
      const install = await installPlugin({
        manifest: { ...baseManifest, permissions: ['cms.storage'] },
        serverEntrypoint: `
          export function activate(api) {
            api.cms.routes.get('/should-fail', 'plugins.read', () => ({ ok: true }))
          }
        `,
        grantedPermissions: ['cms.storage'],
        uploadsDir,
        db,
        cookie,
      })

      expect(install.status).toBe(201)
      const body = await install.json() as { plugin: { lifecycleStatus: string; lastError: string | null } }
      expect(body.plugin.lifecycleStatus).toBe('error')
      expect(body.plugin.lastError).toMatch(/requires permission "cms.routes"/)
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('registers loop sources with the loops.register permission grant', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-loop-source-'))
    const sourceId = 'acme.workflow.products'
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    try {
      const install = await installPlugin({
        manifest: { ...baseManifest, permissions: ['loops.register'] },
        serverEntrypoint: `
          export function activate(api) {
            api.cms.loops.registerSource({
              id: ${JSON.stringify(sourceId)},
              label: 'Products',
              filterSchema: {},
              orderByOptions: [{ id: 'title', label: 'Title' }],
              fields: [{ id: 'title', label: 'Title' }],
              fetch: async () => ({ items: [], totalItems: 0 }),
              preview: () => [],
            })
          }
        `,
        grantedPermissions: ['loops.register'],
        uploadsDir,
        db,
        cookie,
      })

      expect(install.status).toBe(201)
      const body = await install.json() as { plugin: { lifecycleStatus: string; lastError: string | null } }
      expect(body.plugin.lifecycleStatus).toBe('active')
      expect(body.plugin.lastError).toBeNull()
      await waitForLoopSource(sourceId)
    } finally {
      if (loopSourceRegistry.has(sourceId)) loopSourceRegistry.unregister(sourceId)
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('exposes plugin metadata (id, version, permissions) inside lifecycle hooks', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-metadata-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)

    // The QuickJS-sandboxed plugin can't touch node:fs. We use the hookBus as
    // the sandbox-safe cross-context channel: the plugin emits a hook event
    // with its metadata, and the host subscribes to capture it.
    const captured: Array<Record<string, unknown>> = []
    // Plugin emits arrive force-namespaced as `plugin.<id>.<name>`.
    hookBus.on('test', 'plugin.acme.workflow.metadata.observed', async (payload: unknown) => {
      if (payload && typeof payload === 'object') {
        captured.push(payload as Record<string, unknown>)
      }
    })

    try {
      const install = await installPlugin({
        manifest: { ...baseManifest, permissions: ['cms.routes', 'cms.hooks'] },
        serverEntrypoint: `
          export async function activate(api) {
            await api.cms.hooks.emit('metadata.observed', {
              id: api.plugin.id,
              version: api.plugin.version,
              permissions: api.plugin.permissions.slice().sort().join(','),
            })
            api.plugin.log('hello from', api.plugin.id)
          }
        `,
        grantedPermissions: ['cms.routes', 'cms.hooks'],
        uploadsDir,
        db,
        cookie,
      })
      expect(install.status).toBe(201)
      expect(captured).toEqual([{
        id: 'acme.workflow',
        version: '1.0.0',
        permissions: 'cms.hooks,cms.routes',
      }])
    } finally {
      hookBus.unregisterPlugin('test')
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('pushes admin settings updates into a running plugin VM without a reload', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-settings-push-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    try {
      const install = await installPlugin({
        manifest: {
          ...baseManifest,
          id: 'acme.settings-live',
          permissions: ['cms.routes', 'cms.routes.public'],
          settings: [{ id: 'apiKey', label: 'API key', type: 'text', default: 'initial' }],
        },
        serverEntrypoint: `
          export function activate(api) {
            api.cms.routes.public.get('/key', () => ({ key: api.cms.settings.get('apiKey') }))
          }
        `,
        grantedPermissions: ['cms.routes', 'cms.routes.public'],
        uploadsDir,
        db,
        cookie,
      })
      expect(install.status).toBe(201)

      const before = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.settings-live/runtime/key'),
        db,
        { uploadsDir },
      )
      expect(await before.json()).toEqual({ key: 'initial' })

      const put = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.settings-live/settings', {
          method: 'PUT',
          body: JSON.stringify({ settings: { apiKey: 'rotated' } }),
          headers: { cookie },
        }),
        db,
        { uploadsDir },
      )
      expect(put.status).toBe(200)

      // No reload, no restart — the running VM's mirror was pushed, so the
      // already-registered route handler reads the new value immediately.
      const after = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.settings-live/runtime/key'),
        db,
        { uploadsDir },
      )
      expect(await after.json()).toEqual({ key: 'rotated' })
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('treats a settings update for a plugin with no running worker as a clean no-op', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-settings-noop-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    try {
      // Declarative-only plugin: no `entrypoints.server`, so no worker is
      // ever spawned for it. The settings push must not spawn one either.
      const { entrypoints: _entrypoints, ...manifestWithoutEntrypoints } = baseManifest
      const install = await installPlugin({
        manifest: {
          ...manifestWithoutEntrypoints,
          id: 'acme.settings-dormant',
          permissions: [],
          settings: [{ id: 'apiKey', label: 'API key', type: 'text', default: 'initial' }],
        },
        serverEntrypoint: '', // present in the zip but undeclared — never loaded
        grantedPermissions: [],
        uploadsDir,
        db,
        cookie,
      })
      expect(install.status).toBe(201)

      const put = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.settings-dormant/settings', {
          method: 'PUT',
          body: JSON.stringify({ settings: { apiKey: 'rotated' } }),
          headers: { cookie },
        }),
        db,
        { uploadsDir },
      )
      expect(put.status).toBe(200)
      expect(await put.json()).toEqual({ settings: { apiKey: 'rotated' }, secretsNeedingReentry: [] })
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('updates the VM mirror before settings.changed fires, so listeners read the new values', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-settings-hook-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    try {
      const install = await installPlugin({
        manifest: {
          ...baseManifest,
          id: 'acme.settings-hooks',
          permissions: ['cms.routes', 'cms.routes.public', 'cms.hooks'],
          settings: [{ id: 'apiKey', label: 'API key', type: 'text', default: 'initial' }],
        },
        serverEntrypoint: `
          export function activate(api) {
            let observed = 'unset'
            api.cms.hooks.on('settings.changed', () => {
              observed = api.cms.settings.get('apiKey')
            })
            api.cms.routes.public.get('/observed', () => ({ observed }))
          }
        `,
        grantedPermissions: ['cms.routes', 'cms.routes.public', 'cms.hooks'],
        uploadsDir,
        db,
        cookie,
      })
      expect(install.status).toBe(201)

      // The PUT awaits the hook emission, which awaits the in-worker
      // listener — by the time it returns, `observed` has been captured.
      const put = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.settings-hooks/settings', {
          method: 'PUT',
          body: JSON.stringify({ settings: { apiKey: 'rotated' } }),
          headers: { cookie },
        }),
        db,
        { uploadsDir },
      )
      expect(put.status).toBe(200)

      const res = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.settings-hooks/runtime/observed'),
        db,
        { uploadsDir },
      )
      expect(await res.json()).toEqual({ observed: 'rotated' })
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('force-namespaces plugin emits and rejects impersonation of other plugins', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-hook-namespace-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)

    const seen: Array<{ event: string; payload: unknown }> = []
    const subscribe = (event: string) => {
      hookBus.on('test', event, async (payload: unknown) => {
        seen.push({ event, payload })
      })
    }
    // (b) a forged core name must never reach core-name listeners…
    subscribe('content.entry.created')
    // …it arrives namespaced instead.
    subscribe('plugin.acme.workflow.content.entry.created')
    // (a) a bare custom name lands namespaced; (c) an emit pre-prefixed with
    // the plugin's own id is not double-prefixed (both resolve to this name).
    subscribe('plugin.acme.workflow.sync.done')
    // (d) the impersonation rejection the plugin observed in its catch.
    subscribe('plugin.acme.workflow.rejection.observed')

    try {
      const install = await installPlugin({
        manifest: { ...baseManifest, permissions: ['cms.routes', 'cms.hooks'] },
        serverEntrypoint: `
          export async function activate(api) {
            const bare = await api.cms.hooks.emit('sync.done', { via: 'bare' })
            const prefixed = await api.cms.hooks.emit('plugin.acme.workflow.sync.done', { via: 'prefixed', bare: bare })
            await api.cms.hooks.emit('content.entry.created', { forged: true })
            // (d) another plugin's namespace is rejected with a clear error.
            let rejection = 'none'
            try {
              await api.cms.hooks.emit('plugin.zeta.other.evil', {})
            } catch (err) {
              rejection = String((err && err.message) || err)
            }
            await api.cms.hooks.emit('rejection.observed', { rejection: rejection, prefixed: prefixed })
          }
        `,
        grantedPermissions: ['cms.routes', 'cms.hooks'],
        uploadsDir,
        db,
        cookie,
      })
      expect(install.status).toBe(201)

      // The cross-namespace emit was rejected with the impersonation error.
      const rejected = seen.find((s) => s.event === 'plugin.acme.workflow.rejection.observed')
      expect(rejected?.payload).toMatchObject({
        rejection: expect.stringContaining(
          'Plugin "acme.workflow" cannot emit "plugin.zeta.other.evil"',
        ),
      })

      // The forged core emit never reached the core-name listener.
      expect(seen.filter((s) => s.event === 'content.entry.created')).toEqual([])
      expect(seen.filter((s) => s.event === 'plugin.acme.workflow.content.entry.created')).toEqual([
        { event: 'plugin.acme.workflow.content.entry.created', payload: { forged: true } },
      ])
      // Bare and self-prefixed emits land on the SAME canonical name, and the
      // emit call resolved to that canonical name.
      expect(seen.filter((s) => s.event === 'plugin.acme.workflow.sync.done')).toEqual([
        { event: 'plugin.acme.workflow.sync.done', payload: { via: 'bare' } },
        {
          event: 'plugin.acme.workflow.sync.done',
          payload: { via: 'prefixed', bare: 'plugin.acme.workflow.sync.done' },
        },
      ])
    } finally {
      hookBus.unregisterPlugin('test')
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('aborts a plugin that hangs in an infinite loop instead of blocking the worker', async () => {
    // Direct sandbox-level test — go straight at the VM so we can assert the
    // 5-second deadline kills the runaway. Going through the full install
    // flow would just propagate the same error wrapped in lifecycle prose.
    const { createPluginVm } = await import('../../../server/plugins/quickjs/vm')
    const vm = await createPluginVm({
      pluginSource: `
        ;(function () {
          const __plugin_exports = (globalThis.__plugin_exports = {});
          __plugin_exports.activate = function activate() {
            // Tight loop with no escape — deadline must abort it.
            while (true) {}
          };
        })();
      `,
      env: {
        pluginId: 'acme.runaway',
        manifestVersion: '1.0.0',
        grantedPermissions: [],
        assetBasePath: '/uploads/plugins/acme.runaway/1.0.0',
        settings: {},
        hostCall: async () => null,
        log: () => {},
      },
      evalTimeoutMs: 50,
    })
    try {
      const start = Date.now()
      let caught: unknown = null
      try {
        await vm.runLifecycle('activate')
      } catch (err) {
        caught = err
      }
      const elapsed = Date.now() - start
      // The QuickJS interrupt handler aborts with `InternalError: interrupted`.
      // Use a short test-only deadline so the regression coverage does not
      // make the full suite sleep through the production 5s budget.
      expect(caught).not.toBeNull()
      expect(elapsed).toBeLessThan(1_000)
    } finally {
      vm.dispose()
    }
  }, 3_000)
})
