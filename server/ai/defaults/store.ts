/**
 * Per-scope AI defaults — CRUD over `ai_defaults`.
 *
 * One row per scope (`site`, `content`, `data`, `plugin`). Each row points
 * at a specific `credential_id` (FK with `on delete restrict` — deleting
 * the default credential is rejected at the DB layer; the UI nudges to
 * reassign first).
 *
 * Defaults are site-wide (not per-user). Setting requires the
 * `ai.providers.manage` capability; reading requires `ai.use`.
 */

import type { DbClient } from '../../db/client'
import { isoDateOrNull } from '@core/utils/isoDate'
import type { ToolScope } from '../runtime/types'

// ---------------------------------------------------------------------------
// Records + views
// ---------------------------------------------------------------------------

interface DefaultRecord {
  readonly scope: ToolScope
  readonly credentialId: string
  readonly modelId: string
  readonly updatedAt: string
  readonly updatedBy: string | null
}

interface DefaultRow {
  scope: string
  credential_id: string
  model_id: string
  updated_at: Date | string
  updated_by: string | null
}

function rowToRecord(row: DefaultRow): DefaultRecord {
  return {
    scope: row.scope as ToolScope,
    credentialId: row.credential_id,
    modelId: row.model_id,
    updatedAt: isoDateOrNull(row.updated_at)!,
    updatedBy: row.updated_by,
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listDefaults(db: DbClient): Promise<DefaultRecord[]> {
  const { rows } = await db<DefaultRow>`
    select scope, credential_id, model_id, updated_at, updated_by
    from ai_defaults
  `
  return rows.map(rowToRecord)
}

// ---------------------------------------------------------------------------
// Write — upsert
// ---------------------------------------------------------------------------

export async function setDefaultForScope(
  db: DbClient,
  scope: ToolScope,
  credentialId: string,
  modelId: string,
  updatedByUserId: string | null,
): Promise<DefaultRecord> {
  const { rows } = await db<DefaultRow>`
    insert into ai_defaults (scope, credential_id, model_id, updated_by)
    values (${scope}, ${credentialId}, ${modelId}, ${updatedByUserId})
    on conflict (scope) do update
      set credential_id = excluded.credential_id,
          model_id = excluded.model_id,
          updated_by = excluded.updated_by,
          updated_at = current_timestamp
    returning scope, credential_id, model_id, updated_at, updated_by
  `
  return rowToRecord(rows[0]!)
}

