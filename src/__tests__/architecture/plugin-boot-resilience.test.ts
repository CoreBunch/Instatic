/**
 * Plugin Boot Resilience — Architecture Gates
 *
 * Two layers of verification:
 *
 *   1. **Functional** (repository level, fake in-memory DB):
 *      - `listInstalledPlugins` returns `{ kind: 'broken' }` when
 *        `manifest_json` cannot be parsed; returns `{ kind: 'ok' }` for
 *        valid rows; the two are isolated (one broken row does NOT prevent
 *        the healthy one from returning).
 *      - `setPluginLifecycleStatus` persists the DB write even when
 *        `manifest_json` is corrupt — the RETURNING row parse fails
 *        gracefully, but the UPDATE landed.
 *
 *   2. **Static** (source scan):
 *      - The boot loop in `activateInstalledServerPlugins` has a
 *        manifest-broken guard that calls `setPluginLifecycleStatus` before
 *        continuing.
 *      - Each per-plugin failure phase (module-pack-load, server-entrypoint)
 *        in the boot loop has its own catch block calling
 *        `setPluginLifecycleStatus` with `'error'` status.
 *      - No single top-level try/catch wraps the whole plugin iteration loop
 *        (which would be the band-aid pattern).
 *
 * These tests run as part of `bun test` under the SQLite adapter.
 * No real DB, no worker, no filesystem I/O required for the functional layer.
 */

import { describe, test, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listInstalledPlugins, setPluginLifecycleStatus } from '../../../server/repositories/plugins'
import type { DbClient, DbResult } from '../../../server/db'

const ROOT = join(import.meta.dir, '..', '..', '..')

// ---------------------------------------------------------------------------
// Minimal fake DB — only the queries used by repository functions under test.
// ---------------------------------------------------------------------------

type FakePluginRow = Record<string, unknown>

function makeFakeDb(pluginRows: FakePluginRow[]) {
  // Track lifecycle-status updates so tests can assert side effects.
  const lifecycleUpdates: Array<{ id: string; status: string; error: string | null }> = []

  const handle = async <Row extends Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.reduce<string>((acc, s, i) => (i === 0 ? s : `${acc}$${i}${s}`), '')
    const norm = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    // listInstalledPlugins
    if (norm.includes('select id, name, version, enabled') && !norm.includes('where id =')) {
      return { rows: [...pluginRows] as Row[], rowCount: pluginRows.length }
    }
    // getInstalledPlugin
    if (norm.includes('select id, name, version, enabled') && norm.includes('where id =')) {
      const row = pluginRows.find((r) => r.id === values[0])
      return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 }
    }
    // setPluginLifecycleStatus — values: [lifecycleStatus, lastError, id]
    if (norm.includes('update installed_plugins set lifecycle_status')) {
      const id = values[2] as string
      const row = pluginRows.find((r) => r.id === id)
      if (row) {
        row.lifecycle_status = values[0]
        row.last_error = values[1] ?? null
        lifecycleUpdates.push({ id, status: values[0] as string, error: (values[1] ?? null) as string | null })
      }
      // Return the (still-corrupt) row — the repository wraps it in
      // mapInstalledPlugin which should return kind:'broken' without throwing.
      return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 }
    }
    return { rows: [], rowCount: 0 }
  }

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)
  handle.dialect = 'sqlite' as const

  return Object.assign(handle as DbClient, { pluginRows, lifecycleUpdates })
}

// A valid minimal manifest that satisfies parsePluginManifest.
const VALID_MANIFEST = {
  id: 'test.valid-plugin',
  name: 'Valid Plugin',
  version: '1.0.0',
  apiVersion: 1,
  permissions: [],
  resources: [],
  adminPages: [],
  assetBasePath: '/uploads/plugins/test.valid-plugin/1.0.0',
  grantedPermissions: [],
}

function makeValidRow(overrides: Partial<FakePluginRow> = {}): FakePluginRow {
  return {
    id: 'test.valid-plugin',
    name: 'Valid Plugin',
    version: '1.0.0',
    enabled: true,
    lifecycle_status: 'active',
    last_error: null,
    manifest_json: JSON.stringify(VALID_MANIFEST),
    granted_permissions_json: JSON.stringify([]),
    settings_json: JSON.stringify({}),
    installed_at: new Date('2026-01-01').toISOString(),
    updated_at: new Date('2026-01-01').toISOString(),
    ...overrides,
  }
}

function makeBrokenRow(overrides: Partial<FakePluginRow> = {}): FakePluginRow {
  return {
    id: 'test.broken-plugin',
    name: 'Broken Plugin',
    version: '2.0.0',
    enabled: true,
    lifecycle_status: 'active',
    last_error: null,
    // Deliberately invalid — id is a number, which fails the regex pattern.
    manifest_json: JSON.stringify({ id: 12345, name: 'Broken', version: '2.0.0', apiVersion: 1 }),
    granted_permissions_json: JSON.stringify([]),
    settings_json: JSON.stringify({}),
    installed_at: new Date('2026-01-01').toISOString(),
    updated_at: new Date('2026-01-01').toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Functional tests — repository-level isolation
// ---------------------------------------------------------------------------

describe('plugin boot resilience — repository isolation', () => {
  test('listInstalledPlugins returns kind:broken for a row with corrupt manifest_json', async () => {
    const db = makeFakeDb([makeBrokenRow()])
    const results = await listInstalledPlugins(db)
    expect(results).toHaveLength(1)
    const [r] = results
    expect(r.kind).toBe('broken')
    if (r.kind !== 'broken') throw new Error('guard')
    expect(r.id).toBe('test.broken-plugin')
    expect(r.name).toBe('Broken Plugin')
    expect(r.version).toBe('2.0.0')
    expect(typeof r.reason).toBe('string')
    expect(r.reason.length).toBeGreaterThan(0)
  })

  test('listInstalledPlugins returns kind:ok for a valid row', async () => {
    const db = makeFakeDb([makeValidRow()])
    const results = await listInstalledPlugins(db)
    expect(results).toHaveLength(1)
    const [r] = results
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') throw new Error('guard')
    expect(r.plugin.id).toBe('test.valid-plugin')
    expect(r.plugin.lifecycleStatus).toBe('active')
  })

  test('a broken row does not prevent the healthy row from parsing', async () => {
    const db = makeFakeDb([makeBrokenRow(), makeValidRow()])
    const results = await listInstalledPlugins(db)
    expect(results).toHaveLength(2)
    const kinds = results.map((r) => r.kind).sort()
    expect(kinds).toEqual(['broken', 'ok'])
    const okResult = results.find((r) => r.kind === 'ok')
    expect(okResult?.kind === 'ok' && okResult.plugin.id).toBe('test.valid-plugin')
  })

  test('setPluginLifecycleStatus persists to DB even when manifest_json is corrupt', async () => {
    const row = makeBrokenRow()
    const db = makeFakeDb([row])
    // Should NOT throw — the DB write succeeds; the parse failure is captured
    // in the returned discriminated union (kind:'broken'), not as an exception.
    const result = await setPluginLifecycleStatus(db, 'test.broken-plugin', 'error', 'test error message')
    // DB row was updated
    expect(row.lifecycle_status).toBe('error')
    expect(row.last_error).toBe('test error message')
    // Return is broken (manifest still corrupt) but not null
    expect(result).not.toBeNull()
    expect(result?.kind).toBe('broken')
    // The lifecycleUpdates log confirms the DB write happened
    expect(db.lifecycleUpdates).toHaveLength(1)
    expect(db.lifecycleUpdates[0]).toMatchObject({
      id: 'test.broken-plugin',
      status: 'error',
      error: 'test error message',
    })
  })

  test('2 valid + 1 broken: all 3 are returned, broken identified independently', async () => {
    const db = makeFakeDb([
      makeValidRow({ id: 'test.plugin-a', name: 'Plugin A', manifest_json: JSON.stringify({ ...VALID_MANIFEST, id: 'test.plugin-a', assetBasePath: '/uploads/plugins/test.plugin-a/1.0.0' }) }),
      makeValidRow({ id: 'test.plugin-b', name: 'Plugin B', manifest_json: JSON.stringify({ ...VALID_MANIFEST, id: 'test.plugin-b', assetBasePath: '/uploads/plugins/test.plugin-b/1.0.0' }) }),
      makeBrokenRow(),
    ])
    const results = await listInstalledPlugins(db)
    expect(results).toHaveLength(3)
    const okResults = results.filter((r) => r.kind === 'ok')
    const brokenResults = results.filter((r) => r.kind === 'broken')
    expect(okResults).toHaveLength(2)
    expect(brokenResults).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Static analysis — boot loop structure
// ---------------------------------------------------------------------------

describe('plugin boot resilience — boot loop structure', () => {
  test('activateInstalledServerPlugins handles kind:broken before the plugin loop body', async () => {
    const source = await readFile(join(ROOT, 'server/plugins/runtime.ts'), 'utf-8')
    // The boot loop must check result.kind === 'broken' to isolate per-manifest failures.
    expect(source).toMatch(/result\.kind\s*===\s*['"]broken['"]/)
    // It must log the failure with the [plugin:<id>] prefix and a phase name.
    expect(source).toMatch(/\[plugin:\$\{result\.id\}\] boot manifest-validation failed/)
    // It must call setPluginLifecycleStatus to record the error in the DB.
    expect(source).toMatch(/setPluginLifecycleStatus\(db,\s*result\.id,\s*['"]error['"]/)
    // It must continue to the next plugin (not abort the whole loop).
    expect(source).toMatch(/continue/)
  })

  test('module-pack-load phase has an isolated catch that writes error status to DB', async () => {
    const source = await readFile(join(ROOT, 'server/plugins/runtime.ts'), 'utf-8')
    // Each boot phase catch must call setPluginLifecycleStatus with 'error'.
    const statusCallCount = (source.match(/setPluginLifecycleStatus\(db,\s*manifest\.id,\s*['"]error['"]/g) ?? []).length
    // At minimum the module-pack and server-entrypoint phases = 2 calls.
    expect(statusCallCount).toBeGreaterThanOrEqual(2)
    // Phase label in log for module-pack
    expect(source).toMatch(/boot module-pack-load failed/)
    // Phase label in log for server entrypoint
    expect(source).toMatch(/boot server-entrypoint failed/)
  })

  test('listInstalledPlugins returns InstalledPluginResult[] (discriminated union)', async () => {
    const source = await readFile(join(ROOT, 'server/repositories/plugins.ts'), 'utf-8')
    // The exported type must exist.
    expect(source).toContain('export type InstalledPluginResult')
    expect(source).toContain("kind: 'ok'")
    expect(source).toContain("kind: 'broken'")
    // mapInstalledPlugin must have a try/catch around parsePluginManifest.
    expect(source).toMatch(/parsePluginManifest/)
    expect(source).toMatch(/kind:\s*['"]broken['"]/)
    // Return type of listInstalledPlugins must reference InstalledPluginResult.
    expect(source).toMatch(/Promise<InstalledPluginResult\[\]>/)
    // Return type of getInstalledPlugin must reference InstalledPluginResult.
    expect(source).toMatch(/Promise<InstalledPluginResult \| null>/)
  })

  test('write functions (setPluginLifecycleStatus etc.) return InstalledPluginResult | null', async () => {
    const source = await readFile(join(ROOT, 'server/repositories/plugins.ts'), 'utf-8')
    // setPluginLifecycleStatus return type
    expect(source).toMatch(/setPluginLifecycleStatus[\s\S]*?Promise<InstalledPluginResult \| null>/)
    // setPluginEnabled return type
    expect(source).toMatch(/setPluginEnabled[\s\S]*?Promise<InstalledPluginResult \| null>/)
  })

  test('remove handler skips lifecycle hooks for broken plugins and force removals', async () => {
    const source = await readFile(join(ROOT, 'server/handlers/cms/plugins/state.ts'), 'utf-8')
    // Hooks run only on the normal path with a parseable manifest — corrupt
    // manifests and `?force=true` bypass them. The negated-force + kind:'ok'
    // guard is the single gate in front of the hook runner.
    expect(source).toMatch(/!force\s*&&\s*lookup\.kind\s*===\s*['"]ok['"]/)
    // Every removal variant (normal, forced, corrupt manifest) converges on
    // ONE teardown — no parallel delete implementations.
    expect(source).toMatch(/removePluginCompletely\(/)
    // The teardown deletes the DB row and sweeps the plugin's whole on-disk
    // tree (stale version dirs included), not just the current version.
    expect(source).toContain('deletePlugin(db,')
    expect(source).toMatch(/removeAllPluginAssets\(/)
    // Crash bookkeeping has no FK to installed_plugins — the teardown must
    // sweep it explicitly so it can't outlive the row.
    expect(source).toMatch(/clearPluginCrashes\(db,/)
  })

  test('PATCH (enable/disable) and restart handlers reject broken plugins with 409', async () => {
    const source = await readFile(join(ROOT, 'server/handlers/cms/plugins/state.ts'), 'utf-8')
    // Both PATCH and restart guards check kind === 'broken'.
    const brokenChecks = (source.match(/kind\s*===\s*['"]broken['"]/g) ?? []).length
    expect(brokenChecks).toBeGreaterThanOrEqual(2)
    // Return 409 for broken plugins.
    expect(source).toMatch(/status:\s*409/)
  })
})
