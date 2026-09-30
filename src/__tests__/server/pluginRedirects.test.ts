import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { pgMigrations } from '../../../server/db/migrations-pg'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import type { DbClient, DbResult } from '../../../server/db'
import {
  normalizeRedirectFromPath,
  validatePluginRedirectInput,
  PluginRedirectValidationError,
  type PluginRedirectInput,
  setPluginRedirect,
  listPluginRedirects,
  deletePluginRedirect,
  findPluginRedirect,
  replacePluginRedirects,
} from '../../../server/repositories/pluginRedirects'

function expectInvalid(input: PluginRedirectInput, field: PluginRedirectValidationError['field']): void {
  try {
    validatePluginRedirectInput(input)
    throw new Error('Expected redirect validation to reject')
  } catch (err) {
    expect(err).toBeInstanceOf(PluginRedirectValidationError)
    expect((err as PluginRedirectValidationError).field).toBe(field)
  }
}

describe('plugin redirects repository', () => {
  let testDb: TestDb

  beforeEach(async () => {
    testDb = await createTestDb()
    for (const id of ['plugin.a', 'plugin.b']) {
      await testDb.db`
        insert into installed_plugins (id, name, version, manifest_json)
        values (${id}, ${id}, ${'1.0.0'}, ${JSON.stringify({ id })})
      `
    }
  })

  afterEach(async () => {
    await testDb.cleanup()
  })

  it('AC-12: replaceAll validates before replacing, deduplicates normalized paths, and enforces the cap', async () => {
    const db = testDb.db
    const original = await setPluginRedirect(db, 'plugin.a', { fromPath: '/original', toLocation: '/target', status: 301 })
    const other = await setPluginRedirect(db, 'plugin.b', { fromPath: '/other', toLocation: '/target', status: 301 })
    await expect(replacePluginRedirects(db, 'plugin.a', [
      { fromPath: '/valid', toLocation: '/target', status: 301 },
      { fromPath: '/bad', toLocation: '//bad', status: 301 },
    ])).rejects.toMatchObject({ field: 'toLocation' })
    expect(await listPluginRedirects(db, 'plugin.a')).toEqual([original])
    expect(await replacePluginRedirects(db, 'plugin.a', [
      { fromPath: '/old/', toLocation: '/first', status: 301 },
      { fromPath: '/old', toLocation: '/last', status: 308 },
    ])).toEqual({ count: 1 })
    expect((await listPluginRedirects(db, 'plugin.a')).map((rule) => [rule.fromPath, rule.toLocation])).toEqual([['/old', '/last']])
    const rules: PluginRedirectInput[] = Array.from({ length: 5000 }, (_, index) => ({
      fromPath: `/rule-${index}`, toLocation: '/target', status: 301,
    }))
    expect(await replacePluginRedirects(db, 'plugin.a', rules)).toEqual({ count: 5000 })
    await expect(replacePluginRedirects(db, 'plugin.a', [...rules, rules[0]!])).rejects.toMatchObject({ field: 'limit' })
    await expect(setPluginRedirect(db, 'plugin.a', { fromPath: '/overflow', toLocation: '/target', status: 301 })).rejects.toMatchObject({ field: 'limit' })
    expect((await setPluginRedirect(db, 'plugin.a', { fromPath: '/rule-0', toLocation: '/updated', status: 302 })).toLocation).toBe('/updated')
    expect(await listPluginRedirects(db, 'plugin.a')).toHaveLength(5000)
    expect(await listPluginRedirects(db, 'plugin.b')).toEqual([other])
    expect(await replacePluginRedirects(db, 'plugin.a', [])).toEqual({ count: 0 })
    expect(await listPluginRedirects(db, 'plugin.a')).toEqual([])
    await replacePluginRedirects(db, 'plugin.a', rules.slice(0, 4999))
    const attempts = await Promise.allSettled([
      setPluginRedirect(db, 'plugin.a', { fromPath: '/last-slot-a', toLocation: '/target', status: 301 }),
      setPluginRedirect(db, 'plugin.a', { fromPath: '/last-slot-b', toLocation: '/target', status: 301 }),
    ])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await listPluginRedirects(db, 'plugin.a')).toHaveLength(5000)
  })

  it('AC-12: replaceAll uses one transaction and rolls back deletion and inserts on a database failure', async () => {
    const db = testDb.db
    const original = await setPluginRedirect(db, 'plugin.a', { fromPath: '/original', toLocation: '/target', status: 301 })
    let transactions = 0
    const failingDb: DbClient = Object.assign(
      async <Row = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<DbResult<Row>> => db<Row>(strings, ...values),
      {
        unsafe: db.unsafe, close: db.close, dialect: db.dialect,
        transaction: async <T>(fn: (tx: DbClient) => Promise<T>): Promise<T> => {
          transactions += 1
          return db.transaction(async (tx) => {
            const failingTx: DbClient = Object.assign(
              async <Row = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<DbResult<Row>> => {
                if (strings.join(' ').includes('insert into plugin_redirects') && values[1] === '/fail') {
                  throw new Error('Injected database write failure')
                }
                return tx<Row>(strings, ...values)
              },
              { unsafe: tx.unsafe, transaction: tx.transaction, close: tx.close, dialect: tx.dialect },
            )
            return fn(failingTx)
          })
        },
      },
    )
    await expect(replacePluginRedirects(failingDb, 'plugin.a', [
      { fromPath: '/valid', toLocation: '/target', status: 301 },
      { fromPath: '/fail', toLocation: '/target', status: 301 },
    ])).rejects.toThrow('Injected database write failure')
    expect(transactions).toBe(1)
    expect(await listPluginRedirects(db, 'plugin.a')).toEqual([original])
  })

  it('AC-13: the oldest rule wins across plugins, with lower plugin id breaking timestamp ties', async () => {
    const db = testDb.db
    await setPluginRedirect(db, 'plugin.b', { fromPath: '/shared', toLocation: '/b', status: 308 })
    await setPluginRedirect(db, 'plugin.a', { fromPath: '/shared', toLocation: '/a', status: 301 })
    await db`update plugin_redirects set created_at = ${'2026-09-29T00:00:00.000Z'} where plugin_id = ${'plugin.b'}`
    expect((await findPluginRedirect(db, '/shared'))?.pluginId).toBe('plugin.b')
    await setPluginRedirect(db, 'plugin.b', { fromPath: '/shared', toLocation: '/b-updated', status: 302 })
    expect((await findPluginRedirect(db, '/shared'))?.toLocation).toBe('/b-updated')
    await db`update plugin_redirects set created_at = ${'2026-09-29T00:00:00.000Z'} where plugin_id = ${'plugin.a'}`
    expect((await findPluginRedirect(db, '/shared'))?.pluginId).toBe('plugin.a')
    await deletePluginRedirect(db, 'plugin.a', '/shared')
    expect((await findPluginRedirect(db, '/shared'))?.pluginId).toBe('plugin.b')
  })

  it('AC-8: trailing slashes share a rule while raw path matching stays exact and case-sensitive', async () => {
    const db = testDb.db
    const first = await setPluginRedirect(db, 'plugin.a', { fromPath: '/old/', toLocation: '/new', status: 301 })
    expect(first.fromPath).toBe('/old')
    expect(await findPluginRedirect(db, '/old')).toEqual(first)
    expect(await findPluginRedirect(db, '/old/')).toEqual(first)
    expect(await findPluginRedirect(db, '/Old')).toBeNull()
    expect(await findPluginRedirect(db, '/%6Fld')).toBeNull()
    expect(await findPluginRedirect(db, '/old/child')).toBeNull()
    expect(await findPluginRedirect(db, '/old?x=1')).toBeNull()
    expect(await findPluginRedirect(db, '/admin/x')).toBeNull()
    await setPluginRedirect(db, 'plugin.a', { fromPath: '/old', toLocation: '/updated', status: 308 })
    expect(await listPluginRedirects(db, 'plugin.a')).toHaveLength(1)
    expect((await findPluginRedirect(db, '/old/'))?.toLocation).toBe('/updated')
    await setPluginRedirect(db, 'plugin.a', { fromPath: '/', toLocation: '/home', status: 301 })
    expect((await findPluginRedirect(db, '/'))?.fromPath).toBe('/')
    expect(await deletePluginRedirect(db, 'plugin.a', '/old/')).toBe(true)
    expect(await findPluginRedirect(db, '/old')).toBeNull()
  })

  it('AC-10: set, list and delete isolate rules by their owning plugin', async () => {
    const db = testDb.db
    const first = await setPluginRedirect(db, 'plugin.a', { fromPath: '/old', toLocation: '/a', status: 301 })
    const other = await setPluginRedirect(db, 'plugin.b', { fromPath: '/old', toLocation: '/b', status: 302 })
    const updated = await setPluginRedirect(db, 'plugin.a', { fromPath: '/old', toLocation: '/updated', status: 308 })
    expect(updated.createdAt).toBe(first.createdAt)
    expect(updated.pluginId).toBe('plugin.a')
    expect(updated.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await setPluginRedirect(db, 'plugin.a', { fromPath: '/aaa', toLocation: null, status: 410 })
    expect((await listPluginRedirects(db, 'plugin.a')).map((rule) => rule.fromPath)).toEqual(['/aaa', '/old'])
    expect(await listPluginRedirects(db, 'plugin.b')).toEqual([other])
    expect(await deletePluginRedirect(db, 'plugin.b', '/aaa')).toBe(false)
    expect(await deletePluginRedirect(db, 'plugin.a', '/old/')).toBe(true)
    expect(await deletePluginRedirect(db, 'plugin.a', '/old')).toBe(false)
    expect(await deletePluginRedirect(db, 'plugin.a', '//invalid')).toBe(false)
    expect(await listPluginRedirects(db, 'plugin.b')).toEqual([other])
    expect((await listPluginRedirects(db, 'plugin.a')).map((rule) => rule.fromPath)).toEqual(['/aaa'])
  })

  it('AC-7: source paths require printable ASCII and explain percent-encoding', () => {
    const valid: PluginRedirectInput = { fromPath: '/caf%C3%A9', toLocation: '/new', status: 301 }
    for (const fromPath of ['/café', '/你好', '/old\u0000', '/old\u007f', '/old\u0085']) {
      expectInvalid({ ...valid, fromPath }, 'fromPath')
      expect(() => normalizeRedirectFromPath(fromPath)).toThrow(PluginRedirectValidationError)
      expect(() => normalizeRedirectFromPath(fromPath)).toThrow(/percent-encode.*\/caf%C3%A9/)
    }
    expect(validatePluginRedirectInput(valid)).toEqual(valid)
  })

  it('AC-7: validates every redirect field at the repository boundary', () => {
    const valid: PluginRedirectInput = { fromPath: '/old', toLocation: '/new', status: 301 }
    for (const fromPath of ['', 'old', '//old', '/old?q=x', '/old#x', '/old path', '/old\r\n', '/old\u0000', '/old\u007f', '/old\u0085', '/' + 'x'.repeat(2048), '/admin', '/admin/x', '/admin/', '/_instatic', '/_instatic/x', '/uploads', '/uploads/x']) {
      expectInvalid({ ...valid, fromPath }, 'fromPath')
      expect(() => normalizeRedirectFromPath(fromPath)).toThrow(PluginRedirectValidationError)
    }
    for (const toLocation of [null, '', 'new', '//example.com/new', '/\\evil.com', '/\\\\x', 'ftp://example.com/new', 'javascript:alert(1)', 'https://', '/new path', '/new\r\nlocation:/evil', '/new\u0000', '/new\u007f', '/new\u0085', '/' + 'x'.repeat(2048), '/old', '/old/']) {
      expectInvalid({ ...valid, toLocation }, 'toLocation')
    }
    expectInvalid({ ...valid, status: 200 as PluginRedirectInput['status'] }, 'status')
    expectInvalid({ ...valid, status: 410 }, 'toLocation')
    for (const status of [301, 302, 307, 308] as const) {
      expect(validatePluginRedirectInput({ ...valid, status }).status).toBe(status)
    }
    expect(validatePluginRedirectInput({ fromPath: '/gone', toLocation: null, status: 410 }).toLocation).toBeNull()
    for (const fromPath of ['/', '/administrator', '/_instatic-extra', '/uploads-other', '/' + 'x'.repeat(2047)]) {
      expect(validatePluginRedirectInput({ ...valid, fromPath }).fromPath).toBe(fromPath)
    }
    for (const toLocation of ['/new?x=y#anchor', 'http://example.com/new', 'https://example.com/new?x=y', '/' + 'x'.repeat(2047)]) {
      expect(validatePluginRedirectInput({ ...valid, toLocation }).toLocation).toBe(toLocation)
    }
    expect(validatePluginRedirectInput({ ...valid, fromPath: '/old/' }).fromPath).toBe('/old')
  })

  it('AC-14: both dialects add migration 031 with equivalent redirect storage', async () => {
    const pg = pgMigrations.find((migration) => migration.id === '031_plugin_redirects')
    const sqlite = sqliteMigrations.find((migration) => migration.id === '031_plugin_redirects')
    expect(pg).toBeDefined()
    expect(sqlite).toBeDefined()
    expect(pg!.sql.replaceAll('timestamptz', 'text')).toBe(sqlite!.sql)
    await testDb.db`
      insert into plugin_redirects (plugin_id, from_path, to_location, status, created_at, updated_at)
      values (${'plugin.a'}, ${'/old'}, ${'/new'}, ${301}, ${'2026-09-30T00:00:00.000Z'}, ${'2026-09-30T00:00:00.000Z'})
    `
    const { rows } = await testDb.db`select from_path, to_location, status from plugin_redirects`
    expect(rows).toEqual([{ from_path: '/old', to_location: '/new', status: 301 }])
  })
})
