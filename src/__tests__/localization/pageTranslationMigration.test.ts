import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'

describe('page translation relationship additive migration', () => {
  it('appends the native field in every branch, preserving custom fields and authored definitions on rerun', () => {
    const db = new Database(':memory:')
    try {
      db.run('create table data_tables (id text, branch_id text, fields_json text)')
      const original = [{ id: 'title', type: 'text' }, { id: 'custom', type: 'text', label: 'Custom' }]
      const authored = { id: 'translationGroup', type: 'text', label: 'Authored label' }
      db.query('insert into data_tables values (?, ?, ?)').run('pages', 'main', JSON.stringify(original))
      db.query('insert into data_tables values (?, ?, ?)').run('pages', 'branch', JSON.stringify([...original, authored]))
      db.query('insert into data_tables values (?, ?, ?)').run('products', 'main', JSON.stringify(original))
      const migration = sqliteMigrations.find((entry) => entry.id === '033_page_translation_group')!
      db.run(migration.sql)
      db.run(migration.sql)
      const fields = (id: string, branch: string) => JSON.parse(db.query<{ fields_json: string }, [string, string]>('select fields_json from data_tables where id = ? and branch_id = ?').get(id, branch)!.fields_json)
      expect(fields('pages', 'main')).toEqual([...original, { type: 'text', id: 'translationGroup', label: 'Translation group', builtIn: true }])
      expect(fields('pages', 'branch')).toEqual([...original, authored])
      expect(fields('products', 'main')).toEqual(original)
    } finally {
      db.close()
    }
  })
})
