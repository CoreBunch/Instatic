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

export interface ProtectedTableRoute {
  slug: string
  routeBase: string
  rule: AccessRule
}

/** Every routable main-branch table whose entries are not open to anyone. */
export async function listProtectedTableRoutes(db: DbClient): Promise<ProtectedTableRoute[]> {
  const { rows } = await db<{ slug: string; route_base: string; access_json: unknown }>`
    select slug, route_base, access_json
      from data_tables
     where branch_id = ${MAIN_BRANCH_ID}
       and deleted_at is null
       and access_json is not null
       and route_base <> ''
  `
  return rows
    .map((row) => ({
      slug: row.slug,
      routeBase: normalizeRouteBase(row.route_base),
      rule: parseAccessRule(row.access_json),
    }))
    .filter((entry) => entry.rule.level !== 'public')
}

export async function getTableAccess(db: DbClient, tableId: string): Promise<AccessRule | null> {
  const { rows } = await db<{ access_json: unknown }>`
    select access_json from data_tables
     where branch_id = ${MAIN_BRANCH_ID} and logical_id = ${tableId} and deleted_at is null
  `
  return rows[0] ? parseAccessRule(rows[0].access_json) : null
}

/** Store the rule. Returns the table's route base, or null when there is no such table. */
export async function writeTableAccess(
  db: DbClient,
  tableId: string,
  rule: AccessRule,
): Promise<string | null> {
  const { rows } = await db<{ route_base: string }>`
    update data_tables
       set access_json = ${rule.level === 'public' ? null : rule}, updated_at = ${nowIso()}
     where branch_id = ${MAIN_BRANCH_ID} and logical_id = ${tableId} and deleted_at is null
    returning route_base
  `
  return rows[0] ? normalizeRouteBase(rows[0].route_base) : null
}
