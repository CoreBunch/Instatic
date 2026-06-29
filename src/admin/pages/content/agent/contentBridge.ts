/**
 * Content-scope browser bridge — turns a server-issued `toolRequest` into
 * a live mutation against the content workspace via the registered
 * `ContentBridgeHandle`.
 *
 * The chat panel's stream loop calls `executeContentTool(name, input)`
 * when scope === 'content'; the result is POSTed to /admin/api/ai/tool-result.
 *
 * Per-tool inputs are re-validated against TypeBox at this boundary —
 * defence in depth. The server already validated against the same schema
 * (via Anthropic Zod or OpenAI JSON Schema) but the canonical TypeBox
 * shape is the single source of truth and may carry stricter constraints
 * the SDK translation drops.
 *
 * Mirrors `src/admin/pages/site/agent/executor.ts` — same canonical
 * `AiToolOutput` return type, plugged into the same stream-event processor in
 * `agentSlice.ts`.
 */

import { aiToolError, aiToolOk, type AiToolOutput } from '@core/ai'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Type, parseValue, type Static } from '@core/utils/typeboxHelpers'
import { getContentBridgeHandle } from './contentBridgeHandle'

// ---------------------------------------------------------------------------
// Per-tool TypeBox schemas — mirror server/ai/tools/content/writeTools.ts.
// ---------------------------------------------------------------------------

const FieldsRecord = Type.Record(Type.String(), Type.Unknown())

const StatusUnion = Type.Union([
  Type.Literal('draft'),
  Type.Literal('unpublished'),
  Type.Literal('published'),
  Type.Literal('scheduled'),
])

const CreateDocumentSchema = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  fields: Type.Optional(FieldsRecord),
  status: Type.Optional(StatusUnion),
})

const DeleteDocumentSchema = Type.Object({
  documentId: Type.String({ minLength: 1 }),
})

const SetDocumentStatusSchema = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  status: StatusUnion,
  scheduledAt: Type.Optional(Type.String({ minLength: 1 })),
})

const SetDocumentFieldSchema = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  fieldId: Type.String({ minLength: 1 }),
  value: Type.Unknown(),
})

const SetDocumentFieldsSchema = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  fields: FieldsRecord,
})

const SetDocumentAuthorSchema = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  userId: Type.String({ minLength: 1 }),
})

const SetActiveDocumentSchema = Type.Object({
  documentId: Type.String({ minLength: 1 }),
})

const SetActiveCollectionSchema = Type.Object({
  tableId: Type.String({ minLength: 1 }),
})

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Execute one content-scope write tool. Always resolves with a result
 * (never throws) — failures become `{ ok: false, error }` so the
 * server-side bridge resolver fires and the driver loop sees a tool error
 * rather than hanging.
 */
export async function executeContentTool(
  toolName: string,
  rawInput: unknown,
): Promise<AiToolOutput> {
  try {
    const handle = getContentBridgeHandle()
    switch (toolName) {
      case 'content_create_document':
        return await handleCreateDocument(handle, rawInput)
      case 'content_delete_document':
        return await handleDeleteDocument(handle, rawInput)
      case 'content_set_document_status':
        return await handleSetDocumentStatus(handle, rawInput)
      case 'content_set_document_field':
        return await handleSetDocumentField(handle, rawInput)
      case 'content_set_document_fields':
        return await handleSetDocumentFields(handle, rawInput)
      case 'content_set_document_author':
        return await handleSetDocumentAuthor(handle, rawInput)
      case 'content_set_active_document':
        return await handleSetActiveDocument(handle, rawInput)
      case 'content_set_active_collection':
        return await handleSetActiveCollection(handle, rawInput)
      default:
        return aiToolError(`Unknown content tool: ${toolName}`)
    }
  } catch (err) {
    const message = getErrorMessage(err, `Tool ${toolName} failed.`)
    return aiToolError(message)
  }
}

// ---------------------------------------------------------------------------
// Per-tool handlers
// ---------------------------------------------------------------------------

async function handleCreateDocument(
  handle: ReturnType<typeof getContentBridgeHandle>,
  rawInput: unknown,
): Promise<AiToolOutput> {
  const input = parseInput(CreateDocumentSchema, rawInput) as Static<typeof CreateDocumentSchema>
  const documentId = await handle.createDocument({
    tableId: input.tableId,
    fields: input.fields,
    status: input.status,
  })
  return aiToolOk({ documentId })
}

async function handleDeleteDocument(
  handle: ReturnType<typeof getContentBridgeHandle>,
  rawInput: unknown,
): Promise<AiToolOutput> {
  const input = parseInput(DeleteDocumentSchema, rawInput) as Static<typeof DeleteDocumentSchema>
  await handle.deleteDocument(input.documentId)
  return aiToolOk()
}

async function handleSetDocumentStatus(
  handle: ReturnType<typeof getContentBridgeHandle>,
  rawInput: unknown,
): Promise<AiToolOutput> {
  const input = parseInput(SetDocumentStatusSchema, rawInput) as Static<typeof SetDocumentStatusSchema>
  if (input.status === 'scheduled' && !input.scheduledAt) {
    return aiToolError("scheduledAt is required when status='scheduled'.")
  }
  await handle.setDocumentStatus({
    documentId: input.documentId,
    status: input.status,
    scheduledAt: input.scheduledAt,
  })
  return aiToolOk()
}

async function handleSetDocumentField(
  handle: ReturnType<typeof getContentBridgeHandle>,
  rawInput: unknown,
): Promise<AiToolOutput> {
  const input = parseInput(SetDocumentFieldSchema, rawInput) as Static<typeof SetDocumentFieldSchema>
  await handle.setDocumentField({
    documentId: input.documentId,
    fieldId: input.fieldId,
    value: input.value,
  })
  return aiToolOk()
}

async function handleSetDocumentFields(
  handle: ReturnType<typeof getContentBridgeHandle>,
  rawInput: unknown,
): Promise<AiToolOutput> {
  const input = parseInput(SetDocumentFieldsSchema, rawInput) as Static<typeof SetDocumentFieldsSchema>
  await handle.setDocumentFields({
    documentId: input.documentId,
    fields: input.fields,
  })
  return aiToolOk()
}

async function handleSetDocumentAuthor(
  handle: ReturnType<typeof getContentBridgeHandle>,
  rawInput: unknown,
): Promise<AiToolOutput> {
  const input = parseInput(SetDocumentAuthorSchema, rawInput) as Static<typeof SetDocumentAuthorSchema>
  await handle.setDocumentAuthor({
    documentId: input.documentId,
    userId: input.userId,
  })
  return aiToolOk()
}

async function handleSetActiveDocument(
  handle: ReturnType<typeof getContentBridgeHandle>,
  rawInput: unknown,
): Promise<AiToolOutput> {
  const input = parseInput(SetActiveDocumentSchema, rawInput) as Static<typeof SetActiveDocumentSchema>
  const ok = await handle.selectDocument(input.documentId)
  if (!ok) {
    return aiToolError(`Document ${input.documentId} not found (or not in a content collection).`)
  }
  return aiToolOk()
}

async function handleSetActiveCollection(
  handle: ReturnType<typeof getContentBridgeHandle>,
  rawInput: unknown,
): Promise<AiToolOutput> {
  const input = parseInput(SetActiveCollectionSchema, rawInput) as Static<typeof SetActiveCollectionSchema>
  const ok = await handle.selectCollection(input.tableId)
  if (!ok) {
    return aiToolError(`Collection ${input.tableId} not found.`)
  }
  return aiToolOk()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseInput<T>(schema: Parameters<typeof parseValue>[0], raw: unknown): T {
  // Wraps parseValue so handlers stay short. Throws on invalid shape; the
  // catch in `executeContentTool` converts to `{ ok: false, error }`.
  return parseValue(schema, raw) as T
}
