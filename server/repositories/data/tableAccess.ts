/**
 * A data table's access rule: who may open its entry routes on the
 * published site (`data_tables.access_json`, null = anyone).
 *
 * Unlike a page's rule, which is page content and takes effect on publish,
 * a table's rule is a live setting on the main branch. Changing it goes
 * through `setTableAccess` in `server/publish/tableAccess.ts`, which also
 * drops the table's baked pages and cached renders.
 */
import type { DbClient } from '../../db/client'
import { MAIN_BRANCH_ID } from '@core/branches'
import { parseAccessRule, type AccessRule } from '@core/members'
import { normalizeRouteBase } from '@core/templates'
import { nowIso } from '@core/utils/isoDate'

export interface ProtectedTable {
  id: string
  slug: string
  /** Normalised route base, or null for a table with no entry routes. */
  routeBase: string | null
  rule: AccessRule
}

/** Every main-branch table whose rows are not open to anyone. */
export async function listProtectedTables(db: DbClient): Promise<ProtectedTable[]> {
  const { rows } = await db<{ logical_id: string; slug: string; route_base: string; access_json: unknown }>`
    select logical_id, slug, route_base, access_json
      from data_tables
     where branch_id = ${MAIN_BRANCH_ID}
       and deleted_at is null
       and access_json is not null
  `
  return rows
    .map((row) => ({
      id: row.logical_id,
      slug: row.slug,
      routeBase: row.route_base.trim() === '' ? null : normalizeRouteBase(row.route_base),
      rule: parseAccessRule(row.access_json),
    }))
    .filter((entry) => entry.rule.level !== 'public')
}

/**
 * Slug → id of every live main-branch table. What an entry template's target
 * (a list of table slugs) is resolved through when access rules are built.
 */
export async function listTableIdsBySlug(db: DbClient): Promise<Map<string, string>> {
  const { rows } = await db<{ logical_id: string; slug: string }>`
    select logical_id, slug
      from data_tables
     where branch_id = ${MAIN_BRANCH_ID}
       and deleted_at is null
  `
  return new Map(rows.map((row) => [row.slug, row.logical_id]))
}

export async function getTableAccess(db: DbClient, tableId: string): Promise<AccessRule | null> {
  const { rows } = await db<{ access_json: unknown }>`
    select access_json from data_tables
     where branch_id = ${MAIN_BRANCH_ID} and logical_id = ${tableId} and deleted_at is null
  `
  return rows[0] ? parseAccessRule(rows[0].access_json) : null
}

/** Store the rule. Returns false when there is no such table. */
export async function writeTableAccess(
  db: DbClient,
  tableId: string,
  rule: AccessRule,
): Promise<boolean> {
  const { rows } = await db<{ route_base: string }>`
    update data_tables
       set access_json = ${rule.level === 'public' ? null : rule}, updated_at = ${nowIso()}
     where branch_id = ${MAIN_BRANCH_ID} and logical_id = ${tableId} and deleted_at is null
    returning route_base
  `
  return rows.length > 0
}
