import { describe, expect, it } from 'bun:test'
import { normalizePostgresRow } from '../postgres'

describe('postgres row normalization', () => {
  it('parses string-valued JSON columns and normalizes dates', () => {
    const createdAt = new Date('2026-06-29T12:03:32.000Z')

    const row = normalizePostgresRow({
      id: 'message_1',
      content_json: '[{"kind":"text","text":"hello"}]',
      metadata_json: '{"scope":"site","nested":{"ok":true}}',
      broken_json: '{not valid json',
      settings_json: { already: 'parsed' },
      created_at: createdAt,
      title: 'Plain text',
    })

    expect(row.content_json).toEqual([{ kind: 'text', text: 'hello' }])
    expect(row.metadata_json).toEqual({ scope: 'site', nested: { ok: true } })
    expect(row.broken_json).toBe('{not valid json')
    expect(row.settings_json).toEqual({ already: 'parsed' })
    expect(row.created_at).toBe(createdAt.toISOString())
    expect(row.title).toBe('Plain text')
  })
})
