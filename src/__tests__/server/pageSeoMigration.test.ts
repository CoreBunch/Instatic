import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { pgMigrations } from '../../../server/db/migrations-pg'
import { PAGE_SEO_FIELDS } from '@core/data/pageSeoFields'

describe('additive native page SEO fields', () => {
  it('adds ordinary fields to every pages branch while preserving custom fields and row data', () => {
    const db = new Database(':memory:')
    db.exec('create table data_tables (id text, logical_id text, fields_json text); create table data_rows (cells_json text)')
    const custom = { id: 'custom', type: 'text', label: 'Custom' }
    for (const id of ['pages', 'branch:pages']) db.query('insert into data_tables values (?, ?, ?)').run(id, 'pages', JSON.stringify([custom]))
    db.query('insert into data_tables values (?, ?, ?)').run('posts', 'posts', JSON.stringify([custom]))
    db.query('insert into data_rows values (?)').run('{"seoTitle":"Existing","custom":"Preserved"}')
    const sql = sqliteMigrations.find((migration) => migration.id === '032_page_seo')!.sql
    db.exec(sql)
    db.exec(sql)
    for (const row of db.query<{ fields_json: string }, []>("select fields_json from data_tables where logical_id = 'pages'").all()) {
      expect(JSON.parse(row.fields_json)).toEqual([custom, ...PAGE_SEO_FIELDS])
    }
    expect(db.query<{ fields_json: string }, []>("select fields_json from data_tables where id = 'posts'").get()?.fields_json).toBe(JSON.stringify([custom]))
    expect(db.query<{ cells_json: string }, []>('select cells_json from data_rows').get()?.cells_json).toBe('{"seoTitle":"Existing","custom":"Preserved"}')
    expect(pgMigrations.find((migration) => migration.id === '032_page_seo')).toBeDefined()
    db.close()
  })
})
