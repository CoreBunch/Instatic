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

/** A second resource for LIKE: text with non-ASCII letters and wildcards. */
const LIKE_SEED: Array<[string, Record<string, unknown>]> = [
  ['a', { s: 'École' }],
  ['b', { s: 'ÉCOLE' }],
  ['c', { s: 'İstanbul' }],
  ['d', { s: '50% off' }],
  ['e', { s: '50 off' }],
  ['f', { s: 'under_score' }],
  ['g', { s: 'underXscore' }],
  ['h', { s: 'back\\slash' }],
]

interface FilterCase {
  name: string
  /** Which seeded resource the case runs against. Defaults to the main one. */
  seed?: 'like'
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
  // LIKE folds ASCII letters only, on both sides, on both databases.
  { seed: 'like', name: 'like folds ASCII letters next to a non-ASCII one', options: { filter: { s: { like: 'École%' } } }, ids: ['a', 'b'] },
  { seed: 'like', name: 'like does not fold non-ASCII letters', options: { filter: { s: { like: 'école%' } } }, ids: [] },
  { seed: 'like', name: 'like with a dotted capital I', options: { filter: { s: { like: 'İSTANBUL' } } }, ids: ['c'] },
  { seed: 'like', name: 'an escaped percent is literal', options: { filter: { s: { like: '50\\%%' } } }, ids: ['d'] },
  { seed: 'like', name: 'an unescaped percent is a wildcard', options: { filter: { s: { like: '50%' } } }, ids: ['d', 'e'] },
  { seed: 'like', name: 'an escaped underscore is literal', options: { filter: { s: { like: 'under\\_score' } } }, ids: ['f'] },
  { seed: 'like', name: 'an unescaped underscore matches one character', options: { filter: { s: { like: 'under_score' } } }, ids: ['f', 'g'] },
  { seed: 'like', name: 'an escaped backslash is literal', options: { filter: { s: { like: 'back\\\\slash' } } }, ids: ['h'] },
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

function seededResource(scope: { resourceId: string }, seed: FilterCase['seed']): string {
  return seed === 'like' ? `${scope.resourceId}_like` : scope.resourceId
}

export async function seedPluginRecordFilterCases(
  db: DbClient,
  scope: { pluginId: string; resourceId: string },
): Promise<void> {
  for (const [id, data] of SEED) {
    await createPluginRecord(db, { ...scope, id: `${scope.resourceId}_${id}`, data })
  }
  const like = seededResource(scope, 'like')
  for (const [id, data] of LIKE_SEED) {
    await createPluginRecord(db, { pluginId: scope.pluginId, resourceId: like, id: `${like}_${id}`, data })
  }
}

export async function expectPluginRecordFilterCase(
  db: DbClient,
  scope: { pluginId: string; resourceId: string },
  testCase: FilterCase,
): Promise<void> {
  const resourceId = seededResource(scope, testCase.seed)
  const result = await listPluginRecords(db, scope.pluginId, resourceId, testCase.options)
  const ids = result.records.map((record) => record.id.slice(resourceId.length + 1))
  expect(testCase.ordered ? ids : [...ids].sort()).toEqual(testCase.ids)
  expect(result.totalCount).toBe(testCase.totalCount ?? testCase.ids.length)
}
