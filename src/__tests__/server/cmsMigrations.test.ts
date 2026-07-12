import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { pgMigrations } from '../../../server/db/migrations-pg'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { SYSTEM_ROLES } from '../../../server/auth/capabilities'

describe('CMS migrations', () => {
  it('creates the required CMS tables', () => {
    const sql = pgMigrations.map((m) => m.sql).join('\n')
    expect(sql).toContain('create table if not exists site')
    expect(sql).toContain('create table if not exists users')
    expect(sql).toContain('create table if not exists roles')
    expect(sql).toContain('create table if not exists sessions')
    expect(sql).toContain('create table if not exists audit_events')
    // Unified content store — pages and components live in data_tables/data_rows
    expect(sql).toContain('create table if not exists data_tables')
    expect(sql).toContain('create table if not exists data_rows')
    expect(sql).toContain('create table if not exists data_row_versions')
    expect(sql).toContain('create table if not exists media_assets')
    expect(sql).toContain('create table if not exists published_runtime_assets')
    // Legacy page-specific tables must NOT be present
    expect(sql).not.toContain('create table if not exists pages ')
    expect(sql).not.toContain('create table if not exists page_versions')
  })

  it('stores row content and field definitions as jsonb', () => {
    const sql = pgMigrations.map((m) => m.sql).join('\n')
    // data_rows stores all cell values in cells_json
    expect(sql).toContain('cells_json jsonb not null')
    // data_tables stores field definitions in fields_json
    expect(sql).toContain('fields_json jsonb not null')
  })

  it('stores folder sort order for media folders', () => {
    const sql = pgMigrations.map((m) => m.sql).join('\n')
    expect(sql).toContain('sort_order integer not null default 0')
  })

  it('stores ownership metadata for content, media, and published versions', () => {
    const pgSql = pgMigrations.map((m) => m.sql).join('\n')
    const sqliteSql = sqliteMigrations.map((m) => m.sql).join('\n')

    for (const sql of [pgSql, sqliteSql]) {
      expect(sql).toContain('created_by_user_id text references users(id) on delete set null')
      expect(sql).toContain('updated_by_user_id text references users(id) on delete set null')
      expect(sql).toContain('author_user_id text references users(id) on delete set null')
      expect(sql).toContain('published_by_user_id text references users(id) on delete set null')
      expect(sql).toContain('uploaded_by_user_id text references users(id) on delete set null')
    }

    expect(pgSql).not.toContain('published_by text references users(id)')
    expect(sqliteSql).not.toContain('published_by text references users(id)')
  })

  it('does not keep retired single-admin schema names', () => {
    const sql = pgMigrations.map((m) => m.sql).join('\n')
    expect(sql).not.toContain('admin_users')
    expect(sql).not.toContain('admin_user_id')
    expect(sql).not.toContain('site_singleton')
  })

  it('seeds the expected system roles in both dialects', () => {
    const pgSql = pgMigrations.map((m) => m.sql).join('\n')
    const sqliteSql = sqliteMigrations.map((m) => m.sql).join('\n')
    // The migration seed is the INITIAL snapshot only — Owner/Admin are
    // force-resynced from SYSTEM_ROLES on every boot (syncSystemRoles), so a
    // capability added after the seed migration deliberately never appears
    // in migration SQL (committed migrations are immutable). The gate here
    // is: every role slug is seeded, and every capability the seed DOES
    // grant is still a real capability (no orphaned strings surviving a
    // rename).
    const seededCapabilities = new Set(
      [...`${pgSql}\n${sqliteSql}`.matchAll(/"([a-z]+(?:\.[a-zA-Z]+)+)"/g)]
        .map((match) => match[1]!)
        .filter((value) => /^(dashboard|site|pages|content|media|runtime|storage|plugins|users|roles|audit|data|ai)\./.test(value)),
    )
    const known = new Set<string>(SYSTEM_ROLES.flatMap((role) => role.capabilities))
    for (const seeded of seededCapabilities) {
      expect(known.has(seeded), `migration seeds unknown capability "${seeded}"`).toBe(true)
    }
    for (const role of SYSTEM_ROLES) {
      expect(pgSql).toContain(`'${role.slug}'`)
      expect(sqliteSql).toContain(`'${role.slug}'`)
    }
  })

  it('removes legacy roles.manage grants only from non-Owner roles', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        create table roles (
          id text primary key,
          capabilities_json text not null,
          updated_at text not null default current_timestamp
        );
        insert into roles (id, capabilities_json) values
          ('owner', '["users.manage","roles.manage"]'),
          ('legacy-custom', '["users.manage","roles.manage"]'),
          ('ordinary-custom', '["site.read"]');
      `)
      const migration = sqliteMigrations.find(
        (candidate) => candidate.id === '025_remove_non_owner_role_management',
      )
      expect(migration).toBeDefined()
      db.exec(migration!.sql)

      const rows = db.query<{ id: string; capabilities_json: string }, []>(
        'select id, capabilities_json from roles order by id',
      ).all()
      const capabilities = new Map(
        rows.map((row) => [row.id, JSON.parse(row.capabilities_json) as string[]]),
      )
      expect(capabilities.get('owner')).toEqual(['users.manage', 'roles.manage'])
      expect(capabilities.get('legacy-custom')).toEqual(['users.manage'])
      expect(capabilities.get('ordinary-custom')).toEqual(['site.read'])
    } finally {
      db.close()
    }
  })
})
