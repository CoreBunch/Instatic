/**
 * ContentSnapshot — payload the chat handler hands to content-scope tool
 * handlers via `ToolContext.snapshot`.
 *
 * The browser builds this on every send from the live content workspace
 * state (active document, active collection, the full collection list).
 * Shape stays loose for the same reason as SiteSnapshot — the boundary
 * validation lives in the chat handler.
 *
 * Body content is exchanged as **markdown**. The browser bridge converts
 * Tiptap JSON ↔ markdown on read/write so the model only ever sees a
 * compact string instead of a deeply nested ProseMirror node tree.
 */

export interface ContentSnapshot {
  /** Every postType / page collection in the site (lightweight). */
  collections: CollectionSummary[]
  /** Selected collection in the sidebar; null when nothing is selected. */
  activeTableId: string | null
  /** Currently-open document, if any — the agent's primary editing target. */
  activeDocument: ActiveDocument | null
  /** Caller's identity so the agent can reason about authorship. */
  currentUser: CurrentUserInfo
}

interface CollectionSummary {
  id: string
  slug: string
  /** Display label (`pluralLabel` from DataTable — "Posts", "Pages"). */
  label: string
  /** 'postType' | 'page' | 'data' | 'component' — agents care about the first two. */
  kind: string
  /** Live row count excluding soft-deleted. */
  docCount: number
}

export interface ActiveDocument {
  id: string
  tableId: string
  /** Resolved primary-field value — usually the title. */
  title: string
  slug: string
  status: 'draft' | 'unpublished' | 'published' | 'scheduled'
  /** Per-field current value; body field is markdown, not Tiptap JSON. */
  fields: Record<string, unknown>
  /** Snapshot of the collection's field schema for the model's reference. */
  schema: FieldInfo[]
  authorUserId: string | null
  updatedAt: string
}

interface FieldInfo {
  id: string
  label: string
  /** Field type tag from `@core/data/schemas` → `DataFieldType`. */
  type: string
  required: boolean
  /** True for built-in fields (title/slug/body/...) that can't be renamed. */
  builtIn: boolean
  /** For `select`/`multiSelect`: the allowed option ids + labels. */
  options?: Array<{ value: string; label: string }>
  /** For `relation`: the target collection slug. */
  targetTableSlug?: string
  /** For `media`: 'image' | 'video' | 'document' | 'any' (when set). */
  mediaKind?: string
  /** For `media` / `relation`: true when multiple values are allowed. */
  allowMultiple?: boolean
}

interface CurrentUserInfo {
  id: string
  displayName: string
  email: string
}
