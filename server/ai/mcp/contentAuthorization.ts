/**
 * Per-row authorization for browser-relayed MCP content mutations.
 *
 * The browser executes a relayed tool with the connector owner's admin cookie,
 * which may be more powerful than the deliberately narrowed connector token.
 * The generic tool gate checks the connector's capability names; this module
 * completes that check for own-vs-any capabilities before the request reaches
 * the browser, so the cookie cannot widen the delegated authority.
 */
import type { CoreCapability } from '@core/capabilities'
import type { DbClient } from '../../db/client'
import { getDataRow } from '../../repositories/data'

const DOCUMENT_EDIT_TOOLS = new Set([
  'content_delete_document',
  'content_set_document_field',
  'content_set_document_fields',
])

const DOCUMENT_PUBLISH_TOOLS = new Set([
  'content_set_document_status',
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

function ownsDocument(
  row: { authorUserId: string | null; createdByUserId: string | null },
  userId: string,
): boolean {
  return row.authorUserId === userId || (!row.authorUserId && row.createdByUserId === userId)
}

export async function authorizeMcpContentTool(
  db: DbClient,
  userId: string,
  capabilities: readonly CoreCapability[],
  toolName: string,
  input: unknown,
): Promise<void> {
  const checksEditOwnership = DOCUMENT_EDIT_TOOLS.has(toolName)
  const checksPublishOwnership = DOCUMENT_PUBLISH_TOOLS.has(toolName)
  if (!checksEditOwnership && !checksPublishOwnership) return

  const documentId = inputDocumentId(input)
  const row = await getDataRow(db, documentId)
  if (!row) throw new Error(`Document ${documentId} not found.`)

  if (checksEditOwnership) {
    if (capabilities.includes('content.edit.any') || capabilities.includes('content.manage')) return
    if (capabilities.includes('content.edit.own') && ownsDocument(row, userId)) return
  }

  if (checksPublishOwnership) {
    if (capabilities.includes('content.publish.any')) return
    if (capabilities.includes('content.publish.own') && ownsDocument(row, userId)) return
  }

  throw new Error(`Tool ${toolName} is not permitted for document ${documentId}.`)
}
