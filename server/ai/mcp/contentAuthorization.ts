/**
 * Per-row authorization for browser-relayed MCP content mutations.
 *
 * The browser executes a relayed tool with the connector owner's admin cookie,
 * which may be more powerful than the deliberately narrowed connector token.
 * The generic tool gate checks the connector's capability names; this module
 * completes that check with the shared row-access rules (table family plus
 * own-vs-any ownership) before the request reaches the browser, so the cookie
 * cannot widen the delegated authority. Same rules as the HTTP data routes
 * and the server-side read tools: one decision, three callers.
 */
import type { CoreCapability } from '@core/capabilities'
import type { DbClient } from '../../db/client'
import type { BranchScope } from '../../branches/scope'
import { canEditDataRow, canPublishDataRow, resolveRowAccess, type RowCheck } from '../../auth/dataAccess'

const DOCUMENT_TOOL_CHECKS: ReadonlyMap<string, RowCheck> = new Map([
  ['content_delete_document', canEditDataRow],
  ['content_set_document_field', canEditDataRow],
  ['content_set_document_fields', canEditDataRow],
  ['content_set_document_status', canPublishDataRow],
])

function inputDocumentId(input: unknown): string {
  if (
    input === null
    || typeof input !== 'object'
    || !('documentId' in input)
    || typeof input.documentId !== 'string'
  ) {
    throw new Error('Validated content tool input is missing documentId.')
  }
  return input.documentId
}

export async function authorizeMcpContentTool(
  db: DbClient,
  userId: string,
  capabilities: readonly CoreCapability[],
  toolName: string,
  input: unknown,
  /** The branch the connected workspace has open: the tool acts on that row. */
  scope: BranchScope,
): Promise<void> {
  const check = DOCUMENT_TOOL_CHECKS.get(toolName)
  if (!check) return

  const documentId = inputDocumentId(input)
  const access = await resolveRowAccess(db, scope, documentId, { id: userId, capabilities }, check)
  if (access.kind === 'not-found') throw new Error(`Document ${documentId} not found.`)
  if (access.kind === 'forbidden') {
    throw new Error(`Tool ${toolName} is not permitted for document ${documentId}.`)
  }
}
