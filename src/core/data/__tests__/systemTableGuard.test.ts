import { describe, expect, it } from 'bun:test'
import type { DataField, DataTable } from '@core/data/schemas'
import {
  assertSystemTableUpdateAllowed,
  protectedBuiltInCreateCellKey,
} from '@core/data/systemTableGuard'

function field(id: string, overrides: Partial<DataField> = {}): DataField {
  return { id, label: id, type: 'text', builtIn: false, ...overrides } as DataField
}

function table(overrides: Partial<DataTable> = {}): DataTable {
  return {
    id: 'layouts',
    name: 'Layouts',
    slug: 'layouts',
    kind: 'layout',
    routeBase: '/layouts',
    singularLabel: 'Layout',
    pluralLabel: 'Layouts',
    primaryFieldId: 'name',
    fields: [
      field('name', { builtIn: true }),
      field('body', { builtIn: true, type: 'pageTree' }),
    ],
    system: true,
    ...overrides,
  } as DataTable
}

describe('protectedBuiltInCreateCellKey', () => {
  it('flags a create payload that targets a protected built-in value', () => {
    const t = table()
    expect(protectedBuiltInCreateCellKey(t, { body: 'x' })).toBe('body')
    expect(protectedBuiltInCreateCellKey(t, { custom: 'x' })).toBeNull()
  })

  it('returns null on a custom table (nothing locked)', () => {
    const custom = table({ kind: 'data', system: false })
    expect(protectedBuiltInCreateCellKey(custom, { name: 'x', body: 'y' })).toBeNull()
  })
})

describe('assertSystemTableUpdateAllowed', () => {
  it('allows any update on a non-system table', () => {
    const custom = table({ system: false })
    expect(assertSystemTableUpdateAllowed(custom, { name: 'Renamed', slug: 'renamed' })).toBeNull()
  })

  it('rejects identity changes on a system table', () => {
    const t = table()
    expect(assertSystemTableUpdateAllowed(t, { name: 'Renamed' })).toMatch(/name/)
    expect(assertSystemTableUpdateAllowed(t, { slug: 'other' })).toMatch(/slug/)
    expect(assertSystemTableUpdateAllowed(t, { routeBase: '/x' })).toMatch(/routeBase/)
  })

  it('allows idempotent identity writes (same value)', () => {
    const t = table()
    expect(assertSystemTableUpdateAllowed(t, { name: 'Layouts', slug: 'layouts' })).toBeNull()
  })

  it('rejects removing or editing a built-in field', () => {
    const t = table()
    // Drop the built-in `body`.
    expect(assertSystemTableUpdateAllowed(t, { fields: [field('name', { builtIn: true })] })).toMatch(/body/)
    // Edit the built-in `body` (change its label).
    expect(
      assertSystemTableUpdateAllowed(t, {
        fields: [field('name', { builtIn: true }), field('body', { builtIn: true, type: 'pageTree', label: 'Hacked' })],
      }),
    ).toMatch(/body/)
  })

  it('rejects introducing a new built-in field', () => {
    const t = table()
    expect(
      assertSystemTableUpdateAllowed(t, {
        fields: [...t.fields, field('sneaky', { builtIn: true })],
      }),
    ).toMatch(/sneaky/)
  })

  it('allows adding / editing custom fields and changing the primary field', () => {
    const t = table()
    // Add a custom field alongside the unchanged built-ins.
    expect(
      assertSystemTableUpdateAllowed(t, {
        fields: [...t.fields, field('author', { type: 'text' })],
      }),
    ).toBeNull()
    // Change the primary field — always allowed.
    expect(assertSystemTableUpdateAllowed(t, { primaryFieldId: 'body' })).toBeNull()
  })
})
