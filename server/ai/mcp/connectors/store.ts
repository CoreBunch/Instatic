/**
 * MCP connector repository. Dialect-naive (ANSI SQL only): no `now()` in DML,
 * no `::` casts, no Postgres-isms. The `capabilities_json` column is written
 * as a JSON string (parsed back automatically on read — SQLite by the adapter,
 * Postgres by jsonb), matching the `writeJson` convention in other repos.
 *
 * `toConnectorView` is the ONLY projection the HTTP layer may serialise: it
 * drops `tokenHash` entirely. Gated by `ai-mcp-connectors-never-leak.test.ts`.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../../../db/client'
import type { CoreCapability } from '@core/capabilities'
import type { McpConnectorView, McpConnectorType, McpAuthMode } from '@core/ai'
import type { McpConnectorRecord } from './types'

interface ConnectorRow {
  id: string
  user_id: string
  label: string
  type: string
  auth_mode: string
  token_hash: string | null
  // `_json` column → auto-parsed to an array on read (both dialects).
  capabilities_json: CoreCapability[]
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

function rowToRecord(row: ConnectorRow): McpConnectorRecord {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    type: row.type as McpConnectorType,
    authMode: row.auth_mode as McpAuthMode,
    tokenHash: row.token_hash,
    capabilities: Array.isArray(row.capabilities_json) ? row.capabilities_json : [],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }
}

/** Wire-safe projection. Never exposes the token hash. */
export function toConnectorView(rec: McpConnectorRecord): McpConnectorView {
  return {
    id: rec.id,
    label: rec.label,
    type: rec.type,
    authMode: rec.authMode,
    capabilities: [...rec.capabilities],
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt,
    revoked: rec.revokedAt !== null,
  }
}

export async function createConnector(
  db: DbClient,
  input: {
    userId: string
    label: string
    type: McpConnectorType
    capabilities: readonly CoreCapability[]
    tokenHash: string
  },
): Promise<McpConnectorRecord> {
  const id = nanoid()
  const capabilitiesJson = JSON.stringify(input.capabilities)
  const { rows } = await db<ConnectorRow>`
    insert into ai_mcp_connectors (
      id, user_id, label, type, auth_mode, token_hash, capabilities_json
    )
    values (
      ${id}, ${input.userId}, ${input.label}, ${input.type}, 'bearer',
      ${input.tokenHash}, ${capabilitiesJson}
    )
    returning id, user_id, label, type, auth_mode, token_hash,
              capabilities_json, created_at, last_used_at, revoked_at
  `
  if (!rows[0]) throw new Error('Connector insert did not persist')
  return rowToRecord(rows[0])
}

export async function listConnectorsForUser(db: DbClient, userId: string): Promise<McpConnectorRecord[]> {
  const { rows } = await db<ConnectorRow>`
    select id, user_id, label, type, auth_mode, token_hash,
           capabilities_json, created_at, last_used_at, revoked_at
    from ai_mcp_connectors
    where user_id = ${userId}
    order by created_at desc
  `
  return rows.map(rowToRecord)
}

/** Resolve an ACTIVE (non-revoked) connector by its token hash. */
export async function findConnectorByTokenHash(db: DbClient, tokenHash: string): Promise<McpConnectorRecord | null> {
  const { rows } = await db<ConnectorRow>`
    select id, user_id, label, type, auth_mode, token_hash,
           capabilities_json, created_at, last_used_at, revoked_at
    from ai_mcp_connectors
    where token_hash = ${tokenHash} and revoked_at is null
    limit 1
  `
  return rows[0] ? rowToRecord(rows[0]) : null
}

/** Soft-revoke. Scoped by user_id as a cross-user guard. */
export async function revokeConnector(db: DbClient, id: string, userId: string): Promise<boolean> {
  const { rowCount } = await db`
    update ai_mcp_connectors
    set revoked_at = current_timestamp
    where id = ${id} and user_id = ${userId} and revoked_at is null
  `
  return rowCount > 0
}

export async function touchConnectorLastUsed(db: DbClient, id: string): Promise<void> {
  await db`
    update ai_mcp_connectors
    set last_used_at = current_timestamp
    where id = ${id}
  `
}
