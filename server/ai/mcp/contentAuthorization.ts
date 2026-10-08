/**
 * Per-row authorization for browser-relayed MCP content mutations.
 *
 * The browser executes a relayed tool with the connector owner's admin cookie,
 * which may be more powerful than the deliberately narrowed connector token.
 * The generic tool gate checks the connector's capability names; this module
 * completes the table, own-vs-any and localized-reference checks before the
 * request reaches the browser, so the cookie cannot widen delegated authority.
 */
import type { CoreCapability } from '@core/capabilities'
import type { DbClient } from '../../db/client'
import { assertLocalizedDataPrincipalWrite, getDataRow, getDataTable } from '../../repositories/data'
import type { BranchScope } from '../../branches/scope'
import { canEditDataRow, canPublishDataRow, canReadTable, type DataAccessUser } from '../../auth/dataAccess'
import { isRecord } from '@core/utils/isRecord'

const DOCUMENT_EDIT_TOOLS = new Set([
  'content_delete_document',
  'content_set_document_field',
  'content_set_document_fields',
])

const DOCUMENT_PUBLISH_TOOLS = new Set([
  'content_set_document_status',
])

/** The tool engine has already validated these inputs against the tool schema. */
function inputString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw new Error(`Validated content tool input is missing ${key}.`)
  return value
}

function inputFields(input: Record<string, unknown>): Record<string, unknown> {
  if (input.fields === undefined) return {}
  if (!isRecord(input.fields)) throw new Error('Validated content tool input has invalid fields.')
  return input.fields
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
  const checksEditOwnership = DOCUMENT_EDIT_TOOLS.has(toolName)
  const checksPublishOwnership = DOCUMENT_PUBLISH_TOOLS.has(toolName)
  const createsDocument = toolName === 'content_create_document'
  if (!createsDocument && !checksEditOwnership && !checksPublishOwnership) return
  if (!isRecord(input)) throw new Error('Validated content tool input must be a record.')

  const principal: DataAccessUser = { id: userId, capabilities: [...capabilities] }
  const denied = () => new Error(`Tool ${toolName} is not permitted for this document or collection.`)

  if (createsDocument) {
    const table = await getDataTable(db, scope, inputString(input, 'tableId'))
    if (!table || !canReadTable(principal, table) || !capabilities.includes('content.create')) throw denied()
    await assertLocalizedDataPrincipalWrite(db, scope, table.fields, inputFields(input), principal, 'fields')
    return
  }

  const documentId = inputString(input, 'documentId')
  const row = await getDataRow(db, scope, documentId)
  if (!row) throw denied()
  const table = await getDataTable(db, scope, row.tableId)
  if (!table || !canReadTable(principal, table)) throw denied()

  if (checksEditOwnership) {
    if (!canEditDataRow(principal, row)) throw denied()
    if (toolName === 'content_set_document_field') {
      await assertLocalizedDataPrincipalWrite(db, scope, table.fields,
        { [inputString(input, 'fieldId')]: input.value }, principal, 'fields')
    } else if (toolName === 'content_set_document_fields') {
      await assertLocalizedDataPrincipalWrite(db, scope, table.fields, inputFields(input), principal, 'fields')
    }
    return
  }

  if (!canPublishDataRow(principal, row)) throw denied()
}
