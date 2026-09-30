/**
 * `api.cms.redirects` — the sandboxed plugin surface over the plugin-owned
 * redirect table.
 *
 * Three layers are pinned here:
 *   1. VM — every `api.cms.redirects.*` call throws synchronously inside the
 *      sandbox without `redirects.manage`, and forwards the SDK shape to the
 *      right RPC target with it.
 *   2. Protocol — the TypeBox arg schemas are a safety ceiling only
 *      (`replaceAll` ≤ 10000 items, every string ≤ 8192 characters). The real
 *      limits (2048 characters, 5000 rules) belong to the repository, so a
 *      plugin learns about them as `fromPath:` / `toLocation:` / `limit:`.
 *   3. Host — the dispatcher rejects the RPC without the grant (defense in
 *      depth), the handler maps `from`/`to` ↔ `fromPath`/`toLocation`, scopes
 *      every call to the calling plugin, and replies with
 *      `<field>: <message>` for repository validation errors.
 *
 * The host runs against the real repository
 * (`server/repositories/pluginRedirects.ts`) on a real test database from
 * `createTestDb()`. The handle given to the host is a thin recording wrapper,
 * so a test can assert which calls reached the database and can make the
 * next query fail with a plain (non-validation) error.
 *
 * Host calls go through the real `parseApiCall`, so the error a plugin
 * receives is asserted end to end: a wire rejection returns the parser's
 * message, exactly as `workerPool.ts` replies it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import type { DbClient, DbResult } from '../../../server/db'
import { dispatchApiCall } from '../../../server/plugins/host/apiDispatch'
import { hostPlugins, setPluginWorkerDbClient } from '../../../server/plugins/host/registry'
import type { HostPluginRecord } from '../../../server/plugins/host/types'
import { workers } from '../../../server/plugins/host/workerState'
import { ApiCallSchemas, isAllowedApiTarget } from '../../../server/plugins/protocol/apiCallSchema'
import { parseApiCall } from '../../../server/plugins/protocol/parser'
import { TARGET_PERMISSIONS } from '../../../server/plugins/protocol/targets'
import { createPluginVm } from '../../../server/plugins/quickjs/vm'
import {
  PLUGIN_REDIRECTS_MAX_PER_PLUGIN,
  replacePluginRedirects,
} from '../../../server/repositories/pluginRedirects'
import { PLUGIN_PERMISSION_VALUES, PLUGIN_CAPABILITIES, permissions } from '@core/plugin-sdk'
import { createTestDb, type TestDb } from '../helpers/createTestDb'

// ---------------------------------------------------------------------------
// Recording DbClient wrapper
// ---------------------------------------------------------------------------

/** SQL text of every query the host sent to the database, in order. */
const queries: string[] = []
/** When set, the next query rejects with this (a non-validation failure). */
let failNext: Error | null = null

function recordingDb(target: DbClient): DbClient {
  function query<Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> {
    queries.push(strings.join('?').replace(/\s+/g, ' ').trim())
    const err = failNext
    failNext = null
    if (err) return Promise.reject(err)
    return target<Row>(strings, ...values)
  }
  return Object.assign(query, {
    unsafe: <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      queries.push(sql)
      return target.unsafe<Row>(sql, params)
    },
    transaction: <T>(fn: (tx: DbClient) => Promise<T>) => target.transaction((tx) => fn(recordingDb(tx))),
    close: () => target.close(),
    dialect: target.dialect,
  })
}

// ---------------------------------------------------------------------------
// Host harness
// ---------------------------------------------------------------------------

interface Reply { kind: string; correlationId: string; ok: boolean; value?: unknown; error?: string; wire?: boolean }

const PLUGIN_A = 'acme.seo'
const PLUGIN_B = 'other.seo'
const replies: Reply[] = []

function makeEntry(pluginId: string, granted: string[]): HostPluginRecord {
  return {
    manifest: { id: pluginId, grantedPermissions: granted },
    inflightFetches: new Map(),
  } as unknown as HostPluginRecord
}

function installHostPlugin(pluginId: string, granted: string[]): void {
  hostPlugins.set(pluginId, makeEntry(pluginId, granted))
  workers.set(pluginId, { postMessage: (m: Reply) => replies.push(m) } as unknown as Worker)
}

let correlation = 0
/**
 * Sends one api-call through the host exactly as `workerPool.ts` does:
 * `parseApiCall` first (a wire rejection is replied with the parser's
 * message), then `dispatchApiCall`. Returns the reply the plugin receives.
 */
async function callHost(pluginId: string, target: string, args: unknown[]): Promise<Reply> {
  correlation += 1
  const correlationId = 'c' + correlation
  const raw = { kind: 'api-call', correlationId, pluginId, target, args }
  let parsed: ReturnType<typeof parseApiCall>
  try {
    parsed = parseApiCall(raw)
  } catch (err) {
    return { kind: 'api-reply', correlationId, ok: false, error: err instanceof Error ? err.message : String(err), wire: true }
  }
  await dispatchApiCall(parsed)
  const reply = replies.find((r) => r.correlationId === correlationId)
  if (!reply) throw new Error('no reply for ' + target)
  return reply
}

let testDb: TestDb

beforeEach(async () => {
  testDb = await createTestDb()
  for (const id of [PLUGIN_A, PLUGIN_B]) {
    await testDb.db`
      insert into installed_plugins (id, name, version, manifest_json)
      values (${id}, ${id}, ${'1.0.0'}, ${JSON.stringify({ id })})
    `
  }
  queries.length = 0
  replies.length = 0
  failNext = null
  setPluginWorkerDbClient(recordingDb(testDb.db))
})

afterEach(async () => {
  for (const id of [PLUGIN_A, PLUGIN_B]) {
    hostPlugins.delete(id)
    workers.delete(id)
  }
  await testDb.cleanup()
})

interface StoredRow { plugin_id: string; from_path: string; to_location: string | null; status: number }

/** Every stored redirect row, read straight from the table (not through the host). */
async function storedRows(): Promise<StoredRow[]> {
  const { rows } = await testDb.db<StoredRow>`
    select plugin_id, from_path, to_location, status from plugin_redirects
      order by plugin_id asc, from_path asc
  `
  return rows.map((r) => ({ ...r, status: Number(r.status) }))
}

// ---------------------------------------------------------------------------
// Permission + target registration
// ---------------------------------------------------------------------------

const REDIRECT_TARGETS = [
  'cms.redirects.list',
  'cms.redirects.set',
  'cms.redirects.delete',
  'cms.redirects.replaceAll',
] as const

describe('redirects.manage permission', () => {
  it('is a known permission with a high-risk server/cms capability and a builder alias', () => {
    expect(PLUGIN_PERMISSION_VALUES as readonly string[]).toContain('redirects.manage')
    expect((permissions as Record<string, string>).redirectsManage).toBe('redirects.manage')
    const capability = PLUGIN_CAPABILITIES.find((c) => c.permission === ('redirects.manage' as never))
    expect(capability).toMatchObject({
      label: 'Manage site redirects',
      risk: 'high',
      surfaces: ['server', 'cms'],
    })
  })

  it('gates every cms.redirects.* target on redirects.manage', () => {
    for (const target of REDIRECT_TARGETS) {
      expect(isAllowedApiTarget(target)).toBe(true)
      expect((TARGET_PERMISSIONS as Record<string, string>)[target]).toBe('redirects.manage')
    }
  })
})

// ---------------------------------------------------------------------------
// VM layer (AC-9, sandbox half)
// ---------------------------------------------------------------------------

interface RecordedCall { target: string; args: unknown[] }

function vmPluginSource(body: string): string {
  return `
    ;(function () {
      const __plugin_exports = (globalThis.__plugin_exports = {});
      __plugin_exports.activate = async function activate(api) {
        ${body}
      };
    })();
  `
}

async function runInVm(body: string, granted: string[], hostResult: unknown = null) {
  const calls: RecordedCall[] = []
  const vm = await createPluginVm({
    pluginSource: vmPluginSource(body),
    env: {
      pluginId: PLUGIN_A,
      manifestVersion: '1.0.0',
      grantedPermissions: granted,
      assetBasePath: '/uploads/plugins/acme.seo/1.0.0',
      settings: {},
      hostCall: async (target, args) => {
        calls.push({ target, args })
        return hostResult
      },
      log: () => {},
    },
  })
  return { vm, calls }
}

describe('api.cms.redirects in the sandbox', () => {
  const CALLS: Record<(typeof REDIRECT_TARGETS)[number], string> = {
    'cms.redirects.list': 'await api.cms.redirects.list();',
    'cms.redirects.set': "await api.cms.redirects.set({ from: '/old', to: '/new', status: 301 });",
    'cms.redirects.delete': "await api.cms.redirects.delete('/old');",
    'cms.redirects.replaceAll': "await api.cms.redirects.replaceAll([{ from: '/old', to: '/new', status: 301 }]);",
  }

  for (const target of REDIRECT_TARGETS) {
    it(`${target} throws in the VM without redirects.manage (host never reached)`, async () => {
      const { vm, calls } = await runInVm(CALLS[target], ['cms.hooks'])
      try {
        await expect(vm.runLifecycle('activate')).rejects.toThrow(/requires permission "redirects\.manage"/)
        expect(calls).toEqual([])
      } finally {
        vm.dispose()
      }
    })
  }

  it('forwards each call to its RPC target with the SDK-shaped arguments', async () => {
    const body = `
      await api.cms.redirects.list();
      await api.cms.redirects.set({ from: '/old', to: '/new', status: 301 });
      await api.cms.redirects.set({ from: '/gone', status: 410 });
      await api.cms.redirects.delete('/old');
      await api.cms.redirects.replaceAll([{ from: '/a', to: 'https://example.com/b', status: 308 }]);
    `
    const { vm, calls } = await runInVm(body, ['redirects.manage'])
    try {
      await vm.runLifecycle('activate')
      expect(calls).toEqual([
        { target: 'cms.redirects.list', args: [] },
        { target: 'cms.redirects.set', args: [{ from: '/old', to: '/new', status: 301 }] },
        { target: 'cms.redirects.set', args: [{ from: '/gone', to: null, status: 410 }] },
        { target: 'cms.redirects.delete', args: ['/old'] },
        { target: 'cms.redirects.replaceAll', args: [[{ from: '/a', to: 'https://example.com/b', status: 308 }]] },
      ])
    } finally {
      vm.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Protocol schemas (AC-12 caps)
// ---------------------------------------------------------------------------

function apiCall(target: string, args: unknown[]) {
  return { kind: 'api-call', correlationId: 'c', pluginId: PLUGIN_A, target, args }
}

describe('cms.redirects.* arg schemas', () => {
  function check(target: (typeof REDIRECT_TARGETS)[number], args: unknown[]): boolean {
    return Value.Check(ApiCallSchemas[target], apiCall(target, args))
  }

  it('accept well-formed calls', () => {
    expect(check('cms.redirects.list', [])).toBe(true)
    expect(check('cms.redirects.set', [{ from: '/old', to: '/new', status: 301 }])).toBe(true)
    expect(check('cms.redirects.set', [{ from: '/gone', to: null, status: 410 }])).toBe(true)
    expect(check('cms.redirects.set', [{ from: '/gone', status: 410 }])).toBe(true)
    expect(check('cms.redirects.delete', ['/old'])).toBe(true)
    expect(check('cms.redirects.delete', [''])).toBe(true)
    expect(check('cms.redirects.replaceAll', [[]])).toBe(true)
  })

  it('let the repository own the real limits: 5001 rules and 2049-char strings pass the wire', () => {
    const rule = { from: '/x', to: '/y', status: 301 }
    const long = '/' + 'a'.repeat(2048)
    expect(check('cms.redirects.replaceAll', [Array.from({ length: 5001 }, () => rule)])).toBe(true)
    expect(check('cms.redirects.set', [{ from: long, to: '/new', status: 301 }])).toBe(true)
    expect(check('cms.redirects.set', [{ from: '/old', to: long, status: 301 }])).toBe(true)
    expect(check('cms.redirects.delete', [long])).toBe(true)
  })

  it('cap replaceAll at 10000 items (safety ceiling)', () => {
    const rule = { from: '/x', to: '/y', status: 301 }
    expect(check('cms.redirects.replaceAll', [Array.from({ length: 10000 }, () => rule)])).toBe(true)
    expect(check('cms.redirects.replaceAll', [Array.from({ length: 10001 }, () => rule)])).toBe(false)
  })

  it('cap every string at 8192 characters (safety ceiling)', () => {
    const atCeiling = '/' + 'a'.repeat(8191)
    const long = '/' + 'a'.repeat(8192)
    expect(check('cms.redirects.delete', [atCeiling])).toBe(true)
    expect(check('cms.redirects.set', [{ from: long, to: '/new', status: 301 }])).toBe(false)
    expect(check('cms.redirects.set', [{ from: '/old', to: long, status: 301 }])).toBe(false)
    expect(check('cms.redirects.delete', [long])).toBe(false)
    expect(check('cms.redirects.replaceAll', [[{ from: long, to: '/new', status: 301 }]])).toBe(false)
  })

  it('reject unknown statuses and extra keys', () => {
    expect(check('cms.redirects.set', [{ from: '/old', to: '/new', status: 303 }])).toBe(false)
    expect(check('cms.redirects.set', [{ from: '/old', to: '/new', status: '301' }])).toBe(false)
    expect(check('cms.redirects.set', [{ from: '/old', to: '/new', status: 301, regex: true }])).toBe(false)
    expect(check('cms.redirects.list', ['extra'])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Host dispatcher + handler (AC-7, AC-9 host half, AC-10, AC-12)
// ---------------------------------------------------------------------------

describe('cms.redirects.* host dispatch', () => {
  it('rejects every target without redirects.manage and never touches the repository (AC-9)', async () => {
    installHostPlugin(PLUGIN_A, ['cms.hooks'])
    const argsFor: Record<(typeof REDIRECT_TARGETS)[number], unknown[]> = {
      'cms.redirects.list': [],
      'cms.redirects.set': [{ from: '/old', to: '/new', status: 301 }],
      'cms.redirects.delete': ['/old'],
      'cms.redirects.replaceAll': [[{ from: '/old', to: '/new', status: 301 }]],
    }
    for (const target of REDIRECT_TARGETS) {
      const reply = await callHost(PLUGIN_A, target, argsFor[target])
      expect(reply.ok).toBe(false)
      expect(reply.error).toBe(`Plugin "${PLUGIN_A}" requires permission "redirects.manage"`)
    }
    expect(queries).toEqual([])
  })

  it('maps the SDK shape to the repository and back', async () => {
    installHostPlugin(PLUGIN_A, ['redirects.manage'])

    const set = await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: '/old/', to: '/new', status: 301 }])
    expect(set.ok).toBe(true)
    expect(await storedRows()).toEqual([
      { plugin_id: PLUGIN_A, from_path: '/old', to_location: '/new', status: 301 },
    ])
    expect(set.value).toEqual({
      from: '/old',
      to: '/new',
      status: 301,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    })

    const gone = await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: '/gone', status: 410 }])
    expect(gone.ok).toBe(true)
    expect(await storedRows()).toContainEqual({ plugin_id: PLUGIN_A, from_path: '/gone', to_location: null, status: 410 })

    const list = await callHost(PLUGIN_A, 'cms.redirects.list', [])
    expect(list.value).toEqual([
      { from: '/gone', to: null, status: 410, createdAt: expect.any(String), updatedAt: expect.any(String) },
      { from: '/old', to: '/new', status: 301, createdAt: expect.any(String), updatedAt: expect.any(String) },
    ])

    const del = await callHost(PLUGIN_A, 'cms.redirects.delete', ['/old'])
    expect(del).toMatchObject({ ok: true, value: true })
    const delAgain = await callHost(PLUGIN_A, 'cms.redirects.delete', ['/old'])
    expect(delAgain).toMatchObject({ ok: true, value: false })

    const replaced = await callHost(PLUGIN_A, 'cms.redirects.replaceAll', [[
      { from: '/a', to: '/b', status: 302 },
      { from: '/c', status: 410 },
    ]])
    expect(replaced).toMatchObject({ ok: true, value: { count: 2 } })
    expect(await storedRows()).toEqual([
      { plugin_id: PLUGIN_A, from_path: '/a', to_location: '/b', status: 302 },
      { plugin_id: PLUGIN_A, from_path: '/c', to_location: null, status: 410 },
    ])
  })

  it('scopes list/set/delete/replaceAll to the calling plugin (AC-10)', async () => {
    installHostPlugin(PLUGIN_A, ['redirects.manage'])
    installHostPlugin(PLUGIN_B, ['redirects.manage'])

    await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: '/shared', to: '/a', status: 301 }])
    await callHost(PLUGIN_B, 'cms.redirects.set', [{ from: '/shared', to: '/b', status: 302 }])
    await callHost(PLUGIN_B, 'cms.redirects.set', [{ from: '/only-b', to: '/b2', status: 301 }])

    // Same `from` in two plugins = two rows, no overwrite.
    const listA = await callHost(PLUGIN_A, 'cms.redirects.list', [])
    expect((listA.value as Array<{ from: string; to: string }>).map((r) => [r.from, r.to])).toEqual([['/shared', '/a']])

    // A cannot delete B's rule.
    const delB = await callHost(PLUGIN_A, 'cms.redirects.delete', ['/only-b'])
    expect(delB).toMatchObject({ ok: true, value: false })

    // A's replaceAll leaves B's rules alone.
    await callHost(PLUGIN_A, 'cms.redirects.replaceAll', [[]])
    const listB = await callHost(PLUGIN_B, 'cms.redirects.list', [])
    expect((listB.value as Array<{ from: string; to: string }>).map((r) => [r.from, r.to])).toEqual([
      ['/only-b', '/b2'],
      ['/shared', '/b'],
    ])

    expect(await storedRows()).toEqual([
      { plugin_id: PLUGIN_B, from_path: '/only-b', to_location: '/b2', status: 301 },
      { plugin_id: PLUGIN_B, from_path: '/shared', to_location: '/b', status: 302 },
    ])
  })

  it('turns repository validation errors into "<field>: <message>" replies (AC-7)', async () => {
    installHostPlugin(PLUGIN_A, ['redirects.manage'])

    const badFrom = await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: 'old', to: '/new', status: 301 }])
    expect(badFrom.ok).toBe(false)
    expect(badFrom.error).toStartWith('fromPath: ')

    const missingTo = await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: '/old', status: 301 }])
    expect(missingTo.ok).toBe(false)
    expect(missingTo.error).toStartWith('toLocation: ')

    const badReplace = await callHost(PLUGIN_A, 'cms.redirects.replaceAll', [[
      { from: '/ok', to: '/fine', status: 301 },
      { from: 'nope', to: '/x', status: 301 },
    ]])
    expect(badReplace.ok).toBe(false)
    expect(badReplace.error).toStartWith('fromPath: ')
    expect(await storedRows()).toEqual([])
  })

  it('surfaces the per-plugin cap as a "limit:" error (AC-12)', async () => {
    installHostPlugin(PLUGIN_A, ['redirects.manage'])
    await replacePluginRedirects(
      testDb.db,
      PLUGIN_A,
      Array.from({ length: PLUGIN_REDIRECTS_MAX_PER_PLUGIN }, (_, i) => ({ fromPath: '/r' + i, toLocation: '/t', status: 301 })),
    )
    const reply = await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: '/one-more', to: '/t', status: 301 }])
    expect(reply.ok).toBe(false)
    expect(reply.error).toStartWith('limit: ')
    expect(await storedRows()).toHaveLength(PLUGIN_REDIRECTS_MAX_PER_PLUGIN)
  })
  it('rejects oversized input with the repository field name, through the real parser (AC-7, AC-12)', async () => {
    installHostPlugin(PLUGIN_A, ['redirects.manage'])
    const long = '/' + 'a'.repeat(2048)

    const tooMany = await callHost(
      PLUGIN_A,
      'cms.redirects.replaceAll',
      [Array.from({ length: PLUGIN_REDIRECTS_MAX_PER_PLUGIN + 1 }, (_, i) => ({ from: '/r' + i, to: '/t', status: 301 }))],
    )
    expect(tooMany.ok).toBe(false)
    expect(tooMany.error).toStartWith('limit:')

    const longFrom = await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: long, to: '/new', status: 301 }])
    expect(longFrom.ok).toBe(false)
    expect(longFrom.error).toStartWith('fromPath:')

    const longTo = await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: '/old', to: long, status: 301 }])
    expect(longTo.ok).toBe(false)
    expect(longTo.error).toStartWith('toLocation:')

    const longInReplace = await callHost(PLUGIN_A, 'cms.redirects.replaceAll', [[{ from: long, to: '/new', status: 301 }]])
    expect(longInReplace.error).toStartWith('fromPath:')

    // Nothing was stored by any of the rejected calls.
    expect(await storedRows()).toEqual([])
  })

  it('still rejects past the safety ceiling at the wire (> 8192 chars, > 10000 items)', async () => {
    installHostPlugin(PLUGIN_A, ['redirects.manage'])
    const huge = '/' + 'a'.repeat(8192)

    const hugeFrom = await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: huge, to: '/new', status: 301 }])
    expect(hugeFrom).toMatchObject({ ok: false, wire: true })
    expect(hugeFrom.error).toStartWith('Invalid api-call payload for cms.redirects.set:')

    const hugeDelete = await callHost(PLUGIN_A, 'cms.redirects.delete', [huge])
    expect(hugeDelete).toMatchObject({ ok: false, wire: true })

    const tooManyItems = await callHost(
      PLUGIN_A,
      'cms.redirects.replaceAll',
      [Array.from({ length: 10001 }, () => ({ from: '/x', to: '/y', status: 301 }))],
    )
    expect(tooManyItems).toMatchObject({ ok: false, wire: true })

    const stringStatus = await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: '/old', to: '/new', status: '301' }])
    expect(stringStatus).toMatchObject({ ok: false, wire: true })

    expect(queries).toEqual([])
  })

  it("delete('') resolves false instead of rejecting", async () => {
    installHostPlugin(PLUGIN_A, ['redirects.manage'])
    const reply = await callHost(PLUGIN_A, 'cms.redirects.delete', [''])
    expect(reply).toMatchObject({ ok: true, value: false })
    // The repository rejects '' as a path before it builds any SQL.
    expect(queries).toEqual([])
  })

  it('returns [] from an empty list() and { count: 0 } from replaceAll([]), clearing the caller', async () => {
    installHostPlugin(PLUGIN_A, ['redirects.manage'])
    expect(await callHost(PLUGIN_A, 'cms.redirects.list', [])).toMatchObject({ ok: true, value: [] })

    await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: '/old', to: '/new', status: 301 }])
    expect(await callHost(PLUGIN_A, 'cms.redirects.replaceAll', [[]])).toMatchObject({ ok: true, value: { count: 0 } })
    expect(await callHost(PLUGIN_A, 'cms.redirects.list', [])).toMatchObject({ ok: true, value: [] })
  })

  it('names toLocation when `to` is missing or null for a 301, and when 410 carries a `to`', async () => {
    installHostPlugin(PLUGIN_A, ['redirects.manage'])

    const missing = await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: '/old', status: 301 }])
    expect(missing.ok).toBe(false)
    expect(missing.error).toStartWith('toLocation:')

    const explicitNull = await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: '/old', to: null, status: 301 }])
    expect(explicitNull.ok).toBe(false)
    expect(explicitNull.error).toStartWith('toLocation:')

    // The repository rejects both before any write: nothing is stored.
    expect(await storedRows()).toEqual([])

    const goneWithTo = await callHost(PLUGIN_A, 'cms.redirects.set', [{ from: '/gone', to: '/x', status: 410 }])
    expect(goneWithTo.ok).toBe(false)
    expect(goneWithTo.error).toStartWith('toLocation:')
    expect(await storedRows()).toEqual([])
  })

  it('replies a non-validation repository failure as a plain message with no stack', async () => {
    installHostPlugin(PLUGIN_A, ['redirects.manage'])
    for (const [target, args] of [
      ['cms.redirects.list', []],
      ['cms.redirects.set', [{ from: '/old', to: '/new', status: 301 }]],
      ['cms.redirects.delete', ['/old']],
      ['cms.redirects.replaceAll', [[]]],
    ] as const) {
      failNext = new Error('database is locked')
      const reply = await callHost(PLUGIN_A, target, [...args])
      // The failure came from a real query, not from validation.
      expect(failNext).toBeNull()
      expect(reply).toMatchObject({ ok: false, error: 'database is locked' })
      expect(reply.error).not.toContain('\n')
      expect(reply.error).not.toMatch(/\bat\s.+:\d+/)
    }
  })
})
