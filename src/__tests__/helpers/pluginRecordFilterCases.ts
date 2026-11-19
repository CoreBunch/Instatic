/**
 * One table of `list` filter and ordering cases, run against SQLite
 * (`pluginRecords.test.ts`) and Postgres (`pluginRecordsPostgres.test.ts`).
 * The two databases extract JSON differently (typed values vs text), so the
 * same expectations passing on both is the proof that a plugin's queries mean
 * one thing wherever the site runs.
 */
import { expect } from 'bun:test'
import type { StorageListOptions } from '@core/plugin-sdk/storageSchemas'
import type { DbClient } from '../../../server/db/client'
import { createPluginRecord, listPluginRecords } from '../../../server/repositories/pluginRecords'

/** Seeded in this order; ids are the letters. */
const SEED: Array<[string, Record<string, unknown>]> = [
  ['a', { n: 9, s: 'apple', ok: true }],
  ['b', { n: 10, s: 'Banana', ok: false }],
  ['c', { n: 2.5, s: 'cherry' }],
  // The same values as text: a typed comparison must not confuse them.
  ['d', { n: '9', s: '10', ok: 'true' }],
  ['e', { s: null }],
  ['f', { n: true }],
]

interface FilterCase {
  name: string
  options: StorageListOptions
  /** Expected record ids. Compared in order when `ordered`, as a set otherwise. */
  ids: string[]
  ordered?: boolean
  totalCount?: number
}

export const PLUGIN_RECORD_FILTER_CASES: FilterCase[] = [
  { name: 'number shorthand', options: { filter: { n: 9 } }, ids: ['a'] },
  { name: 'number gt', options: { filter: { n: { gt: 9 } } }, ids: ['b'] },
  { name: 'number range', options: { filter: { n: { gte: 2.5, lt: 10 } } }, ids: ['a', 'c'] },
  { name: 'number ne skips other types', options: { filter: { n: { ne: 9 } } }, ids: ['b', 'c'] },
  { name: 'number in', options: { filter: { n: { in: [9, 10] } } }, ids: ['a', 'b'] },
  { name: 'in with mixed types', options: { filter: { n: { in: [9, '9', true] } } }, ids: ['a', 'd', 'f'] },
  { name: 'empty in', options: { filter: { n: { in: [] } } }, ids: [] },
  { name: 'string that looks like a number', options: { filter: { n: '9' } }, ids: ['d'] },
  { name: 'boolean true', options: { filter: { ok: true } }, ids: ['a'] },
  { name: 'boolean false', options: { filter: { ok: false } }, ids: ['b'] },
  { name: 'boolean ne', options: { filter: { ok: { ne: true } } }, ids: ['b'] },
  { name: 'null means missing or null', options: { filter: { s: null } }, ids: ['e', 'f'] },
  { name: 'missing field', options: { filter: { n: null } }, ids: ['e'] },
  { name: 'ne null means present', options: { filter: { n: { ne: null } } }, ids: ['a', 'b', 'c', 'd', 'f'] },
  { name: 'text gt is byte-wise', options: { filter: { s: { gt: 'a' } } }, ids: ['a', 'c'] },
  { name: 'like ignores ASCII case', options: { filter: { s: { like: '%AN%' } } }, ids: ['b'] },
  { name: 'two fields', options: { filter: { n: { gte: 9 }, ok: true } }, ids: ['a'] },
  {
    name: 'order by a number field: missing, boolean, numbers by value, text',
    options: { orderBy: { n: 'asc' } },
    ids: ['e', 'f', 'c', 'a', 'b', 'd'],
    ordered: true,
  },
  {
    name: 'descending reverses the whole sequence',
    options: { orderBy: { n: 'desc' } },
    ids: ['d', 'b', 'a', 'c', 'f', 'e'],
    ordered: true,
  },
  {
    name: 'order by text is byte-wise, with a second key for ties',
    options: { orderBy: { s: 'asc', n: 'asc' } },
    ids: ['e', 'f', 'd', 'b', 'a', 'c'],
    ordered: true,
  },
  {
    name: 'limit and offset page the ordered list and count everything',
    options: { orderBy: { n: 'asc' }, limit: 2, offset: 1 },
    ids: ['f', 'c'],
    ordered: true,
    totalCount: 6,
  },
]

export async function seedPluginRecordFilterCases(
  db: DbClient,
  scope: { pluginId: string; resourceId: string },
): Promise<void> {
  for (const [id, data] of SEED) {
    await createPluginRecord(db, { ...scope, id: `${scope.resourceId}_${id}`, data })
  }
}

export async function expectPluginRecordFilterCase(
  db: DbClient,
  scope: { pluginId: string; resourceId: string },
  testCase: FilterCase,
): Promise<void> {
  const result = await listPluginRecords(db, scope.pluginId, scope.resourceId, testCase.options)
  const ids = result.records.map((record) => record.id.slice(scope.resourceId.length + 1))
  expect(testCase.ordered ? ids : [...ids].sort()).toEqual(testCase.ids)
  expect(result.totalCount).toBe(testCase.totalCount ?? testCase.ids.length)
}
