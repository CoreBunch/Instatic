import { canReadTable, dataRowReadScope, type DataPrincipal } from '../../auth/dataAccess'
import { placeholder, type DbClient } from '../../db/client'

/**
 * Authorized main-branch content for dashboard aggregates and lineup limits.
 * Capabilities come from the same policy as direct row reads. Bind identities;
 * only fixed SQL fragments are interpolated. No row bodies are selected.
 */
export function dashboardContentQuery(db: DbClient, principal: DataPrincipal) {
  const params: unknown[] = []
  const bind = (value: unknown) => {
    params.push(value)
    return placeholder(db.dialect, params.length)
  }
  const families: string[] = []
  if (canReadTable(principal, { system: true })) families.push('t.system = true')
  if (canReadTable(principal, { system: false })) families.push('t.system = false')
  const scope = dataRowReadScope(principal)
  const ownership = scope === 'all' ? '1 = 1' : scope === 'none' ? '1 = 0'
    : `(r.author_user_id = ${bind(principal.id)} or
        (r.author_user_id is null and r.created_by_user_id = ${bind(principal.id)}))`
  const sql = `with visible_tables as (
    select t.id, t.logical_id, t.kind, t.route_base from data_tables t
    where t.branch_id = 'main' and t.deleted_at is null
      and (${families.join(' or ') || '1 = 0'})
  ), visible_rows as (
    select r.logical_id as id, t.logical_id as table_id, t.kind, t.route_base,
           r.slug, r.status, r.scheduled_publish_at, r.published_at, r.updated_at
    from data_rows r join visible_tables t on t.id = r.table_id
    where r.branch_id = 'main' and r.deleted_at is null and ${ownership}
  )`
  return { sql, params, bind }
}
