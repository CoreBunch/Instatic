/**
 * Content-scope write tools — browser-bridged.
 *
 * Eight write tools that mutate the live content workspace through the
 * browser bridge. The server defines schema + description only; the
 * `src/admin/pages/content/agent/contentBridge.ts` dispatcher applies each
 * mutation to the workspace store + editor state.
 *
 * Why browser-bridged (not server CRUD): the user is editing the doc in a
 * Tiptap editor that holds dirty in-memory state. Going through the
 * editor store keeps the user's draft consistent — same pattern as the
 * site editor's executor.
 */

import { Type } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'

// `fields` is a free-form `Record<fieldId, value>`. Per-type validation
// happens on the browser bridge (it knows the collection's field schema).
const FieldsRecord = Type.Record(Type.String(), Type.Unknown())

const DocumentStatus = Type.Union([
  Type.Literal('draft'),
  Type.Literal('unpublished'),
  Type.Literal('published'),
  Type.Literal('scheduled'),
])

// ---------------------------------------------------------------------------
// create_document
// ---------------------------------------------------------------------------

const CreateDocumentInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  fields: Type.Optional(FieldsRecord),
  status: Type.Optional(DocumentStatus),
})

// ---------------------------------------------------------------------------
// Capability requirements (ANY-OF) — each tool mirrors its HTTP-route gate
// in server/handlers/cms/data/access.ts. `set_active_*` are pure editor-state
// switches with no HTTP equivalent and stay gated by `ai.tools.write` alone.
// ---------------------------------------------------------------------------

// Mirrors `requireDataEditor` (DATA_EDIT_CAPABILITIES).
const DOCUMENT_EDIT_CAPS: readonly CoreCapability[] = [
  'content.edit.own',
  'content.edit.any',
  'content.manage',
]

// Mirrors `requireDataPublisher` (DATA_PUBLISH_CAPABILITIES).
const DOCUMENT_PUBLISH_CAPS: readonly CoreCapability[] = [
  'content.publish.own',
  'content.publish.any',
]

// Mirrors `requireDataAuthorManager` (DATA_REASSIGN_CAPABILITIES).
const DOCUMENT_REASSIGN_CAPS: readonly CoreCapability[] = [
  'content.edit.any',
  'content.manage',
]

const createDocumentTool: AiTool = {
  name: 'create_document',
  scope: 'content',
  execution: 'browser',
  requiredCapabilities: ['content.create'],
  description:
    "Create a new document in `tableId`. `fields` is a Record<fieldId, value> per the collection's schema; omit to create an empty draft. `status` defaults to 'draft'. Success data includes the new id as `documentId`; the bridge auto-switches the user's editor to the new doc so they can see what you built.",
  inputSchema: CreateDocumentInput,
}

// ---------------------------------------------------------------------------
// delete_document
// ---------------------------------------------------------------------------

const DeleteDocumentInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
})

const deleteDocumentTool: AiTool = {
  name: 'delete_document',
  scope: 'content',
  execution: 'browser',
  requiredCapabilities: DOCUMENT_EDIT_CAPS,
  description:
    'Soft-delete a document. User can restore via the Trash UI.',
  inputSchema: DeleteDocumentInput,
}

// ---------------------------------------------------------------------------
// set_document_status
// ---------------------------------------------------------------------------

const SetDocumentStatusInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  status: DocumentStatus,
  scheduledAt: Type.Optional(Type.String({ minLength: 1 })),
})

const setDocumentStatusTool: AiTool = {
  name: 'set_document_status',
  scope: 'content',
  execution: 'browser',
  requiredCapabilities: DOCUMENT_PUBLISH_CAPS,
  description:
    "Set the document's lifecycle status. `status='scheduled'` requires `scheduledAt` (ISO datetime). Publishing requires the user to hold content.publish.own (own docs) or content.publish.any (any doc).",
  inputSchema: SetDocumentStatusInput,
}

// ---------------------------------------------------------------------------
// set_document_field
// ---------------------------------------------------------------------------

const SetDocumentFieldInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  fieldId: Type.String({ minLength: 1 }),
  value: Type.Unknown(),
})

const setDocumentFieldTool: AiTool = {
  name: 'set_document_field',
  scope: 'content',
  execution: 'browser',
  requiredCapabilities: DOCUMENT_EDIT_CAPS,
  description:
    "Write one field on a document. `value` shape depends on the field type (read get_collection_schema first if unsure): text/longText/richText/url/email → string; number → number; boolean → boolean; date/dateTime → ISO string; select → option id; multiSelect → option id[]; media → { id } or { id }[]; relation → { rowId } or { rowId }[]; body → markdown string. Bridge converts markdown ↔ Tiptap automatically for body.",
  inputSchema: SetDocumentFieldInput,
}

// ---------------------------------------------------------------------------
// set_document_fields
// ---------------------------------------------------------------------------

const SetDocumentFieldsInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  fields: FieldsRecord,
})

const setDocumentFieldsTool: AiTool = {
  name: 'set_document_fields',
  scope: 'content',
  execution: 'browser',
  requiredCapabilities: DOCUMENT_EDIT_CAPS,
  description:
    'Batch-write multiple fields on one document. `fields` is Record<fieldId, value>; same per-type shapes as set_document_field. Prefer this when generating a whole post (title + slug + body + seo* in one call).',
  inputSchema: SetDocumentFieldsInput,
}

// ---------------------------------------------------------------------------
// set_document_author
// ---------------------------------------------------------------------------

const SetDocumentAuthorInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  userId: Type.String({ minLength: 1 }),
})

const setDocumentAuthorTool: AiTool = {
  name: 'set_document_author',
  scope: 'content',
  execution: 'browser',
  requiredCapabilities: DOCUMENT_REASSIGN_CAPS,
  description:
    'Reassign the document author to another user. Requires the caller to hold content.edit.any. Use list_users to find the right user id.',
  inputSchema: SetDocumentAuthorInput,
}

// ---------------------------------------------------------------------------
// set_active_document
// ---------------------------------------------------------------------------

const SetActiveDocumentInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
})

const setActiveDocumentTool: AiTool = {
  name: 'set_active_document',
  scope: 'content',
  execution: 'browser',
  description:
    "Switch the user's editor to this document so they can watch you work. Call BEFORE editing a doc that isn't already open — the user only sees the active doc, so set_document_field on a non-active doc happens invisibly.",
  inputSchema: SetActiveDocumentInput,
}

// ---------------------------------------------------------------------------
// set_active_collection
// ---------------------------------------------------------------------------

const SetActiveCollectionInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
})

const setActiveCollectionTool: AiTool = {
  name: 'set_active_collection',
  scope: 'content',
  execution: 'browser',
  description:
    'Switch the workspace sidebar focus to this collection. Use when working across collection-level actions (browsing, bulk reviews).',
  inputSchema: SetActiveCollectionInput,
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const contentWriteTools: AiTool[] = [
  createDocumentTool,
  deleteDocumentTool,
  setDocumentStatusTool,
  setDocumentFieldTool,
  setDocumentFieldsTool,
  setDocumentAuthorTool,
  setActiveDocumentTool,
  setActiveCollectionTool,
]
