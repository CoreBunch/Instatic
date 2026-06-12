/**
 * CRUD for data tables.
 *
 *   listDataTables       — read every non-deleted table. System tables sort
 *                          first in a fixed order (pages, posts, components,
 *                          layouts); custom tables follow, ordered by created_at.
 *   getDataTable         — read a single table by id (or null)
 *   getDataTableBySlug   — read a single table by slug (indexed; or null)
 *   createDataTable      — insert a new table
 *   updateDataTable      — partial update (all fields optional)
 *   softDeleteDataTable      — set deleted_at; refuses if rows exist or if the
 *                             table is the seeded `posts` post-type
 *   insertDataTableIfAbsent  — insert only if id absent; used by merge-add / merge-overwrite
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../../db/client'
import { countDataRows } from './rows/read'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { normalizeDataTableFields } from '@core/data/fields'
import type {
  DataField,
  DataTable,
  DataTableKind,
  DataTableListItem,
} from '@core/data/schemas'
import { isoDate } from '@core/utils/isoDate'

interface CreateDataTableInput {
  id?: string
  name: string
  slug: string
  kind?: DataTableKind
  routeBase?: string
  singularLabel: string
  pluralLabel: string
  primaryFieldId?: string
  fields?: DataField[]
  createdByUserId?: string | null
  updatedByUserId?: string | null
}

interface UpdateDataTableInput {
  name?: string
  slug?: string
  routeBase?: string
  singularLabel?: string
  pluralLabel?: string
  primaryFieldId?: string
  fields?: DataField[]
  updatedByUserId?: string | null
}

interface DataTableRow {
  id: string
  name: string
  slug: string
  kind: DataTableKind
  route_base: string
  singular_label: string
  plural_label: string
  primary_field_id: string
  fields_json?: unknown
  /**
   * The `system` column is `not null default 0` (SQLite) / `default false`
   * (Postgres), so every read carries a concrete value. SQLite surfaces it as
   * `0`/`1`, Postgres as a boolean — `mapTable` coerces both via `Boolean`.
   */
  system: number | boolean
  created_by_user_id: string | null
  updated_by_user_id: string | null
  /**
   * Adapters normalize: PG returns Date, SQLite returns ISO string, test fakes
   * may return either. The mapper coerces both via `isoDate` below.
   */
  created_at: string | Date
  updated_at: string | Date
}

function mapTable(row: DataTableRow): DataTable {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    routeBase: row.route_base ? normalizeRouteBase(row.route_base) : normalizeRouteBase(row.slug),
    singularLabel: row.singular_label,
    pluralLabel: row.plural_label,
    primaryFieldId: row.primary_field_id,
    fields: normalizeDataTableFields(row.fields_json),
    system: Boolean(row.system),
    createdByUserId: row.created_by_user_id ?? null,
    updatedByUserId: row.updated_by_user_id ?? null,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  }
}

export async function listDataTables(db: DbClient): Promise<DataTable[]> {
  const { rows } = await db<DataTableRow>`
    select id, name, slug, kind, route_base, singular_label, plural_label,
           primary_field_id, fields_json, system,
           created_by_user_id, updated_by_user_id, created_at, updated_at
    from data_tables
    where deleted_at is null
    order by
      case kind
        when 'page' then 0
        when 'postType' then 1
        when 'component' then 2
        when 'layout' then 3
        else 4
      end,
      created_at asc
  `
  return rows.map(mapTable)
}

/**
 * Like `listDataTables` but enriches each table with the current non-deleted
 * row count. The count is derived via a correlated subselect (one per table)
 * which is fine given the tiny number of tables.
 *
 * SQL is dialect-naive: no Postgres-isms (`::int`, `now()`, `::jsonb`,
 * `any($N::...)`, `distinct on`) — runs identically on SQLite and Postgres.
 */
export async function listDataTablesWithCounts(db: DbClient): Promise<DataTableListItem[]> {
  const { rows } = await db<DataTableRow & { row_count: number | string }>`
    select t.id, t.name, t.slug, t.kind, t.route_base, t.singular_label, t.plural_label,
           t.primary_field_id, t.fields_json, t.system,
           t.created_by_user_id, t.updated_by_user_id, t.created_at, t.updated_at,
           coalesce(
             (select count(*) from data_rows r where r.table_id = t.id and r.deleted_at is null),
             0
           ) as row_count
    from data_tables t
    where t.deleted_at is null
    order by
      case t.kind
        when 'page' then 0
        when 'postType' then 1
        when 'component' then 2
        when 'layout' then 3
        else 4
      end,
      t.created_at asc
  `
  return rows.map((row) => ({
    ...mapTable(row),
    rowCount: Number(row.row_count ?? 0),
  }))
}

export async function getDataTable(db: DbClient, tableId: string): Promise<DataTable | null> {
  const { rows } = await db<DataTableRow>`
    select id, name, slug, kind, route_base, singular_label, plural_label,
           primary_field_id, fields_json, system,
           created_by_user_id, updated_by_user_id, created_at, updated_at
    from data_tables
    where id = ${tableId}
      and deleted_at is null
    limit 1
  `
  return rows[0] ? mapTable(rows[0]) : null
}

/**
 * Read a single non-deleted table by slug. One indexed lookup — the partial
 * unique index `data_tables_slug_active_idx` covers it — so per-call code
 * paths (every `cms.content.*` plugin api-call resolves its table this way)
 * never scan and re-parse the whole table list.
 */
export async function getDataTableBySlug(db: DbClient, slug: string): Promise<DataTable | null> {
  const { rows } = await db<DataTableRow>`
    select id, name, slug, kind, route_base, singular_label, plural_label,
           primary_field_id, fields_json, system,
           created_by_user_id, updated_by_user_id, created_at, updated_at
    from data_tables
    where slug = ${slug}
      and deleted_at is null
    limit 1
  `
  return rows[0] ? mapTable(rows[0]) : null
}

export async function createDataTable(
  db: DbClient,
  input: CreateDataTableInput,
): Promise<DataTable> {
  const fields = normalizeDataTableFields(input.fields ?? [])
  const { rows } = await db<DataTableRow>`
    insert into data_tables (
      id,
      name,
      slug,
      kind,
      route_base,
      singular_label,
      plural_label,
      primary_field_id,
      fields_json,
      created_by_user_id,
      updated_by_user_id
    )
    values (
      ${input.id ?? nanoid()},
      ${input.name},
      ${input.slug},
      ${input.kind ?? 'data'},
      ${normalizeRouteBase(input.routeBase ?? input.slug)},
      ${input.singularLabel},
      ${input.pluralLabel},
      ${input.primaryFieldId ?? 'title'},
      ${fields},
      ${input.createdByUserId ?? null},
      ${input.updatedByUserId ?? input.createdByUserId ?? null}
    )
    returning id, name, slug, kind, route_base, singular_label, plural_label,
              primary_field_id, fields_json, system,
              created_by_user_id, updated_by_user_id, created_at, updated_at
  `
  // NOTE: table creation does NOT seed the default entry template — seeding
  // publishes a page row, which is publish-layer orchestration. Every
  // table-creation entry point calls `ensureDefaultEntryTemplate`
  // (`server/publish/templateSeeding.ts`) right after this returns, and the
  // boot/import backfill covers every other path.
  return mapTable(rows[0])
}

export async function updateDataTable(
  db: DbClient,
  tableId: string,
  input: UpdateDataTableInput,
): Promise<DataTable | null> {
  const fields = input.fields === undefined ? null : normalizeDataTableFields(input.fields)
  const routeBase = input.routeBase === undefined ? null : normalizeRouteBase(input.routeBase)
  const { rows } = await db<DataTableRow>`
    update data_tables
    set name = coalesce(${input.name ?? null}, name),
        slug = coalesce(${input.slug ?? null}, slug),
        route_base = coalesce(${routeBase}, route_base),
        singular_label = coalesce(${input.singularLabel ?? null}, singular_label),
        plural_label = coalesce(${input.pluralLabel ?? null}, plural_label),
        primary_field_id = coalesce(${input.primaryFieldId ?? null}, primary_field_id),
        fields_json = coalesce(${fields}, fields_json),
        updated_by_user_id = coalesce(${input.updatedByUserId ?? null}, updated_by_user_id),
        updated_at = current_timestamp
    where id = ${tableId}
      and deleted_at is null
    returning id, name, slug, kind, route_base, singular_label, plural_label,
              primary_field_id, fields_json, system,
              created_by_user_id, updated_by_user_id, created_at, updated_at
  `
  return rows[0] ? mapTable(rows[0]) : null
}

/**
 * Insert a table only if its id does not already exist. Returns `true` when
 * the table was inserted, `false` when it was skipped (id conflict). Used by
 * the `merge-add` and `merge-overwrite` import strategies.
 *
 * RETURNING id is supported by both Postgres and SQLite.
 */
export async function insertDataTableIfAbsent(
  db: DbClient,
  input: CreateDataTableInput,
): Promise<boolean> {
  const fields = normalizeDataTableFields(input.fields ?? [])
  const { rows } = await db<{ id: string }>`
    insert into data_tables (
      id,
      name,
      slug,
      kind,
      route_base,
      singular_label,
      plural_label,
      primary_field_id,
      fields_json,
      created_by_user_id,
      updated_by_user_id
    )
    values (
      ${input.id ?? nanoid()},
      ${input.name},
      ${input.slug},
      ${input.kind ?? 'data'},
      ${normalizeRouteBase(input.routeBase ?? input.slug)},
      ${input.singularLabel},
      ${input.pluralLabel},
      ${input.primaryFieldId ?? 'title'},
      ${fields},
      ${input.createdByUserId ?? null},
      ${input.updatedByUserId ?? input.createdByUserId ?? null}
    )
    on conflict (id) do nothing
    returning id
  `
  return rows.length > 0
}

/**
 * Refuses to delete system tables or any table that still has non-deleted
 * rows. Both guards live in the repository so other callers (CLI tools,
 * future migrations) inherit the safety check.
 *
 * System status is determined by `table.system === true` (the `system` column,
 * `not null default false`, surfaced through `mapTable`).
 */
export async function softDeleteDataTable(
  db: DbClient,
  tableId: string,
  actorUserId: string | null = null,
): Promise<DataTable | null> {
  const table = await getDataTable(db, tableId)
  if (!table) return null
  if (table.system === true) return null

  if (await countDataRows(db, tableId) > 0) return null

  const { rows } = await db<DataTableRow>`
    update data_tables
    set deleted_at = current_timestamp,
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${tableId}
      and deleted_at is null
    returning id, name, slug, kind, route_base, singular_label, plural_label,
              primary_field_id, fields_json, system,
              created_by_user_id, updated_by_user_id, created_at, updated_at
  `
  return rows[0] ? mapTable(rows[0]) : null
}
