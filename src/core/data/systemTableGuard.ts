/**
 * System-table immutability rules — the single source of truth shared by the
 * server (authoritative enforcement) and the client (UI gating), so both agree
 * on exactly what is frozen on a system table.
 *
 * System tables (`posts`, `pages`, `components`, `layouts` — `system === true`)
 * are NOT fully immutable. They have a genuine manageable surface:
 *   - custom (non-`builtIn`) fields may be added / edited / removed;
 *   - the primary field may be changed.
 * What is frozen for EVERYONE (regardless of capability):
 *   - the table's structural identity: name, slug, route base, labels (and kind,
 *     which the update path can't change anyway);
 *   - its built-in fields — they cannot be edited, removed, or newly created.
 *
 * Built-in field values remain editable on existing records through both the
 * Data workspace and their purpose-built authoring surfaces.
 */

import type { DataField, DataTable, UpdateDataTableInput } from './schemas'

/** Identity fields that can never change on a system table. */
const FROZEN_IDENTITY_KEYS = [
  'name',
  'slug',
  'routeBase',
  'singularLabel',
  'pluralLabel',
] as const satisfies readonly (keyof UpdateDataTableInput)[]

/**
 * Whether a built-in field is protected while creating a structural system
 * record through the generic row endpoint. Existing records remain editable.
 */
function isBuiltInValueCreateLocked(
  table: Pick<DataTable, 'system' | 'kind'>,
  field: Pick<DataField, 'builtIn'>,
): boolean {
  return field.builtIn === true && table.system === true && table.kind !== 'postType'
}

/**
 * First cell key in `cells` that targets a protected built-in field while
 * creating a structural system record, or `null` when none do.
 */
export function protectedBuiltInCreateCellKey(
  table: Pick<DataTable, 'system' | 'kind' | 'fields'>,
  cells: Record<string, unknown>,
): string | null {
  const lockedIds = new Set(
    table.fields.filter((field) => isBuiltInValueCreateLocked(table, field)).map((field) => field.id),
  )
  if (lockedIds.size === 0) return null
  for (const key of Object.keys(cells)) {
    if (lockedIds.has(key)) return key
  }
  return null
}

/** Map a table's built-in fields by id. */
function builtInFieldsById(fields: readonly DataField[]): Map<string, DataField> {
  const map = new Map<string, DataField>()
  for (const field of fields) {
    if (field.builtIn === true) map.set(field.id, field)
  }
  return map
}

/**
 * Validate a requested table update against the frozen surface of a SYSTEM
 * table. Returns an error message when the update touches something immutable,
 * or `null` when the update is allowed (and always `null` for non-system
 * tables — they have no extra restrictions here).
 *
 * Allowed on a system table: adding/editing/removing custom fields, changing
 * the primary field, and idempotent no-op writes of identity fields.
 */
export function assertSystemTableUpdateAllowed(
  existing: Pick<DataTable, 'system' | 'name' | 'slug' | 'routeBase' | 'singularLabel' | 'pluralLabel' | 'fields'>,
  update: UpdateDataTableInput,
): string | null {
  if (existing.system !== true) return null

  // Frozen identity — reject any value that differs from the stored one.
  for (const key of FROZEN_IDENTITY_KEYS) {
    const next = update[key]
    if (next !== undefined && next !== existing[key]) {
      return `System tables can't change their ${key}.`
    }
  }

  // Built-in fields are frozen; custom fields are free.
  if (update.fields !== undefined) {
    const existingBuiltIns = builtInFieldsById(existing.fields)
    const nextById = new Map(update.fields.map((f) => [f.id, f]))

    for (const [id, original] of existingBuiltIns) {
      const next = nextById.get(id)
      if (!next) return `System tables can't remove the built-in field "${id}".`
      if (JSON.stringify(next) !== JSON.stringify(original)) {
        return `System tables can't edit the built-in field "${id}".`
      }
    }

    // No NEW built-in fields may be introduced.
    for (const field of update.fields) {
      if (field.builtIn === true && !existingBuiltIns.has(field.id)) {
        return `System tables can't add a new built-in field ("${field.id}").`
      }
    }
  }

  return null
}
