import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'

describe('page language additive migration', () => {
  it('appends the field in every existing branch without replacing custom fields or duplicating language', () => {
    const db = new Database(':memory:')
    try {
      db.run('create table data_tables (id text, branch_id text, fields_json text)')
      const original = [{ type: 'text', id: 'title' }, { type: 'text', id: 'custom', label: 'My field' }]
      const language = { type: 'text', id: 'language', label: 'Custom language label' }
      db.query('insert into data_tables values (?, ?, ?)').run('pages', 'main', JSON.stringify(original))
      db.query('insert into data_tables values (?, ?, ?)').run('pages', 'draft', JSON.stringify([...original, language]))
      const migration = sqliteMigrations.find((entry) => entry.id === '031_page_language')!
      db.run(migration.sql)
      db.run(migration.sql)
      const main = db.query<{ fields_json: string }, []>("select fields_json from data_tables where branch_id = 'main'").get()!
      const draft = db.query<{ fields_json: string }, []>("select fields_json from data_tables where branch_id = 'draft'").get()!
      expect(JSON.parse(main.fields_json)).toEqual([...original, { type: 'text', id: 'language', label: 'Language', builtIn: true }])
      expect(JSON.parse(draft.fields_json)).toEqual([...original, language])
    } finally {
      db.close()
    }
  })
})
