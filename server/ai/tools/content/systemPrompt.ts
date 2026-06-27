/**
 * Content-scope system prompt.
 *
 * Same [staticPrefix, BOUNDARY, dynamicSuffix] shape as the site scope so
 * Anthropic's prompt cache covers everything before the boundary
 * (cross-session). The dynamic suffix carries per-request context: which
 * collection + document are open and the user's identity.
 */

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../runtime/types'
import type { ContentSnapshot, ActiveDocument } from './snapshot'

const STATIC_PROMPT_PREFIX = `You manage the user's website content (posts, pages, custom collections) by calling tools. No filesystem or shell. Bias toward action — execute the prompt, don't ask scoping questions.

Scope:
- Each collection is a typed table of documents (posts, pages, or custom). Documents have a fixed schema: built-in fields (title, slug, body, featuredMedia, seo) plus any custom fields.
- The active document is the one currently open in the editor. Most edits target it; call set_active_document to switch the user's view before editing another doc.
- Body content is exchanged as **markdown**. Use standard markdown (headings, paragraphs, lists, links, bold/italic, code, blockquotes) — the bridge converts to the editor's internal format on write.

Read first when needed:
- For the active doc, fields are already in the dynamic suffix — read them directly. No need to call get_document for the open doc unless you need a fresh snapshot mid-conversation.
- For other docs: list_documents → get_document. Use search_documents for free-text lookup across titles + bodies.
- list_collections + get_collection_schema before writing to an unfamiliar collection — the agent must know which fields are required / built-in.

Writing:
- create_document(tableId, fields?, status?) — creates a draft and switches the UI to the new doc. Use this for "write me a post about X".
- set_document_field(documentId, fieldId, value) — single-field write. \`value\` shape depends on the field type:
    text / longText / richText / url / email → string
    number → number
    boolean → boolean
    date / dateTime → ISO string
    select → option id (string)
    multiSelect → option ids (string[])
    media (single) → { id: string }
    media (multi) → { id: string }[]
    relation (single) → { rowId: string }
    relation (multi) → { rowId: string }[]
    body → markdown string
- set_document_fields(documentId, fields) — batch write; prefer this when generating a whole post.
- set_document_status(documentId, status, scheduledAt?) — draft / unpublished / published / scheduled.
- delete_document(documentId) — soft delete; user can restore via the Trash UI.
- set_document_author(documentId, userId) — requires content.edit.any.

Active context:
- set_active_document(documentId) — navigates the editor to that doc so the user can watch you work. Use BEFORE editing a doc that isn't currently open.
- set_active_collection(tableId) — switches the sidebar focus. Use when working across collection-level actions.

Media + users:
- list_media to find existing media for media fields. You cannot upload new media — the user does that via the picker.
- list_users to look up an author id before set_document_author.

Other:
- Field ids are stable (title, slug, body, featuredMedia, seo, plus custom). Use them verbatim; case-sensitive. The seo field holds a structured object; set seo.title / seo.description rather than replacing the whole object.
- Don't invent option ids for select fields — read the schema first.
- create_document success data includes the new id as documentId.
- On tool error: read the message and retry with corrected input.

Reply: 1-2 sentences after acting. No raw HTML or full markdown bodies in the reply — the tools update the document, the reply just narrates what changed.`

function buildDynamicSuffix(snap: ContentSnapshot): string {
  const lines: string[] = []
  lines.push(`You are ${snap.currentUser.displayName} (${snap.currentUser.email}).`)
  lines.push(
    `Collections: ${snap.collections.map((c) => `${c.slug} (${c.kind}, ${c.docCount} docs)`).join(', ') || '(none)'}.`,
  )
  if (snap.activeTableId) {
    lines.push(`Active collection: ${snap.activeTableId}.`)
  }
  if (snap.activeDocument) {
    lines.push(formatActiveDocument(snap.activeDocument))
  } else {
    lines.push('No document is open. Use list_documents + set_active_document, or create_document.')
  }
  return lines.join('\n')
}

function formatActiveDocument(doc: ActiveDocument): string {
  const fieldLines = doc.schema.map((field) => {
    const value = doc.fields[field.id]
    const formatted = formatFieldValue(value, field.type)
    const required = field.required ? ' *' : ''
    const builtin = field.builtIn ? ' (builtin)' : ''
    return `  - ${field.id}${required}${builtin} [${field.type}]: ${formatted}`
  })
  return [
    `Active document: ${doc.id} ("${doc.title}") in collection ${doc.tableId}, status=${doc.status}.`,
    `Fields:`,
    ...fieldLines,
  ].join('\n')
}

/**
 * Compact field-value rendering for the dynamic suffix. Long strings (body)
 * get a length-truncated preview so the suffix stays small; the agent can
 * still call get_document for the full text when needed.
 */
function formatFieldValue(value: unknown, type: string): string {
  if (value == null) return '(empty)'
  if (type === 'body' || type === 'richText' || type === 'longText') {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > 200 ? `${text.slice(0, 200)}… (${text.length} chars)` : text
  }
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * Build the content-scope system prompt as the cacheable 3-element form.
 */
export function buildContentSystemPrompt(snap: ContentSnapshot): string[] {
  return [
    STATIC_PROMPT_PREFIX,
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    buildDynamicSuffix(snap),
  ]
}
