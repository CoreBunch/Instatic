/**
 * Content-workspace bridge handle registry.
 *
 * The chat panel runs outside ContentPage's React tree — the bridge
 * dispatcher needs an imperative entry point to mutate the workspace's
 * live state (selected entry, draft fields, persistence calls). ContentPage
 * registers a handle here on mount; the dispatcher reads it and calls
 * methods on it. Same module-level-handle pattern as the site editor's
 * `agent/storeRef.ts` — no React-context plumbing needed across the panel
 * boundary.
 *
 * Why a handle (not a Zustand slice): the content workspace lives in
 * useState + custom hooks today (not in a global store like the site
 * editor). Promoting that to Zustand for the agent would be a bigger
 * refactor; the handle pattern lets us plug the bridge in cleanly today
 * and revisit later if the surface grows.
 */

import type {
  DataRow,
  DataRowStatus,
  DataTable,
} from '@core/data/schemas'

// ---------------------------------------------------------------------------
// Snapshot shape — wire format the agent receives.
//
// Mirrors `server/ai/tools/content/snapshot.ts → ContentSnapshot`. Defined
// structurally here (not imported) so the frontend doesn't reach into
// `server/` — same convention as `PageContext` for the site editor.
// Keep the two in sync.
// ---------------------------------------------------------------------------

export interface ContentAgentCurrentUser {
  id: string
  displayName: string
  email: string
}

interface ContentAgentCollectionSummary {
  id: string
  slug: string
  label: string
  kind: string
  docCount: number
}

export interface ContentAgentFieldInfo {
  id: string
  label: string
  type: string
  required: boolean
  builtIn: boolean
  options?: Array<{ value: string; label: string }>
  targetTableSlug?: string
  mediaKind?: string
  allowMultiple?: boolean
}

export interface ContentAgentActiveDocument {
  id: string
  tableId: string
  title: string
  slug: string
  status: 'draft' | 'unpublished' | 'published' | 'scheduled'
  fields: Record<string, unknown>
  schema: ContentAgentFieldInfo[]
  authorUserId: string | null
  updatedAt: string
}

export interface ContentAgentSnapshot {
  collections: ContentAgentCollectionSummary[]
  activeTableId: string | null
  activeDocument: ContentAgentActiveDocument | null
  currentUser: ContentAgentCurrentUser
}

/**
 * Imperative surface ContentPage exposes to the agent bridge. Every method
 * mutates the live workspace state and returns the resulting shape (or
 * throws on validation failures the dispatcher converts to tool errors).
 */
export interface ContentBridgeHandle {
  /**
   * Per-request snapshot the agent-slice config feeds to the server
   * (becomes ContentSnapshot in the system prompt + tool ctx). Built
   * from the LIVE workspace state at call time, so the agent always
   * sees what the user sees. The handle owns the currentUser closure
   * via its own ref so the config layer doesn't need to thread it.
   */
  buildSnapshot(): ContentAgentSnapshot

  /** Snapshot of every (postType/page) collection — light projection. */
  listCollections(): DataTable[]
  /** Active collection in the sidebar; null when none selected. */
  getActiveCollectionId(): string | null
  /** Currently-open document, if any. */
  getActiveDocument(): DataRow | null
  /** Resolve a row id to its live DataRow (looks up the workspace cache). */
  findDocument(documentId: string): DataRow | null

  /**
   * Switch which document the editor shows. Loads the row if it's not in
   * the workspace cache yet. Returns true on success, false when the row
   * doesn't exist or isn't in a content (postType / page) collection.
   */
  selectDocument(documentId: string): Promise<boolean>
  /** Switch the sidebar focus to a different collection. */
  selectCollection(tableId: string): Promise<boolean>

  /**
   * Create a new draft row in `tableId`. When `fields` is provided, the
   * built-in field values land on the draft before save. Returns the new
   * document's id; the editor auto-switches to it.
   */
  createDocument(args: {
    tableId: string
    fields?: Record<string, unknown>
    status?: DataRowStatus
  }): Promise<string>

  /** Soft-delete a document by id. */
  deleteDocument(documentId: string): Promise<void>

  /**
   * Flip the document status. `scheduledAt` is required when
   * `status === 'scheduled'`. Publishing requires the user to hold the
   * relevant content.publish.* capability — failures from the server are
   * surfaced as thrown Errors.
   */
  setDocumentStatus(args: {
    documentId: string
    status: DataRowStatus
    scheduledAt?: string
  }): Promise<void>

  /** Write one field on a document. `value` shape depends on the field type. */
  setDocumentField(args: {
    documentId: string
    fieldId: string
    value: unknown
  }): Promise<void>

  /** Batch-write multiple fields on a document in one save. */
  setDocumentFields(args: {
    documentId: string
    fields: Record<string, unknown>
  }): Promise<void>

  /** Reassign the document author. Requires content.edit.any server-side. */
  setDocumentAuthor(args: {
    documentId: string
    userId: string
  }): Promise<void>
}

// ---------------------------------------------------------------------------
// Module-level registration — ContentPage sets/clears on mount/unmount.
// ---------------------------------------------------------------------------

let registered: ContentBridgeHandle | null = null

export function setContentBridgeHandle(handle: ContentBridgeHandle | null): void {
  registered = handle
}

export function getContentBridgeHandle(): ContentBridgeHandle {
  if (!registered) {
    throw new Error(
      '[contentBridge] No handle registered. ContentPage must mount before ' +
      'the content-scope agent can dispatch tool calls.',
    )
  }
  return registered
}
