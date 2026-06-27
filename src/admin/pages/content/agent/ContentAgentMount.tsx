/**
 * ContentAgentMount — encapsulates the content workspace's agent wiring.
 *
 * Renders the docked AgentPanel (mirroring the site editor's pattern) +
 * a per-mount Zustand store (AgentSlice only) + a bridge handle
 * registered into the module-level `contentBridgeHandle` registry.
 *
 * Mounted as ContentSidebar's `agentPanel` slot — visibility is driven
 * by ContentSidebar's panel-rail toggle. This component renders nothing
 * UI-decorative itself; just the panel + the provider it needs.
 *
 * Splits out of ContentPage so the page component stays manageable.
 * ContentPage just passes the live workspace + draft + currentUser; this
 * component owns the registration lifecycle.
 *
 * Handle methods close over refs (not direct props) so the latest
 * workspace + draft state is always visible without re-registering the
 * handle on every render — same pattern used by the site editor's
 * `executor` for the same reason.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AgentPanel } from '@site/panels/AgentPanel'
import { AgentStoreProvider } from '@admin/ai/AgentStoreContext'
import { readTitleCell } from '@core/data/cells'
import { normalizeDataTableFields } from '@core/data/fields'
import type { DataField, DataRow, DataTable } from '@core/data/schemas'
import {
  publishCmsDataRow,
  saveCmsDataRowDraft,
} from '@core/persistence'
import { createContentAgentStore } from './contentAgentStore'
import {
  setContentBridgeHandle,
  type ContentAgentActiveDocument,
  type ContentAgentCurrentUser,
  type ContentAgentFieldInfo,
  type ContentAgentSnapshot,
  type ContentBridgeHandle,
} from './contentBridgeHandle'

// `data` (custom tables) + `component` (visual-component definitions) belong
// to other workspaces — keep the agent's view of the world consistent with
// what list_collections returns server-side.
const CONTENT_KIND_VISIBLE: ReadonlySet<string> = new Set(['postType', 'page'])

interface ContentAgentMountProps {
  /** Live workspace state from `useContentWorkspace`. */
  workspace: ContentAgentWorkspaceSurface
  /** Live draft state from `useContentEntryDraft`. */
  draft: ContentAgentDraftSurface
  /** Caller identity for the snapshot's `currentUser` field. */
  currentUser: ContentAgentCurrentUser
  /**
   * Whether the panel is currently visible (ContentSidebar's panel-rail
   * toggle). When true, we set the store's `isAgentOpen` so the
   * AgentPanel renders its UI (the panel CSS hides itself when the slice
   * thinks it's closed, regardless of `display: none` from the sidebar).
   * When false, we clear the open flag so any in-flight focus traps /
   * keyboard handlers tear down cleanly.
   */
  isVisible: boolean
}

/**
 * Subset of useContentWorkspace's return value the bridge actually needs.
 * Avoids importing the workspace hook's full type (which couples this
 * module to the workspace's internals).
 */
interface ContentAgentWorkspaceSurface {
  collections: DataTable[]
  entries: DataRow[]
  selectedEntry: DataRow | null
  selectedCollection: DataTable | null
  selectedCollectionId: string | null
  selectCollection(tableId: string): void
  selectEntry(entry: DataRow | null): void
  deleteEntry(entry: DataRow): Promise<DataRow | null>
  updateEntryStatus(entry: DataRow, status: 'draft' | 'unpublished'): Promise<DataRow>
  updateEntryAuthor(entry: DataRow, userId: string): Promise<DataRow>
  createUntitledEntry(): Promise<DataRow | null>
  updateSelectedEntry(entry: DataRow): void
}

/**
 * Subset of useContentEntryDraft's return value the bridge actually uses
 * to mutate the active document's fields.
 */
interface ContentAgentDraftSurface {
  setTitle(value: string): void
  setSlug(value: string): void
  setSeoTitle(value: string): void
  setSeoDescription(value: string): void
  setFeaturedMediaId(value: string | null): void
  setBody(value: string): void
  handleSaveDraft(): Promise<void>
  applySelectedEntry(entry: DataRow): void
}

export function ContentAgentMount({
  workspace,
  draft,
  currentUser,
  isVisible,
}: ContentAgentMountProps) {
  // Per-mount store — one Zustand instance for the lifetime of this
  // ContentPage render. The store takes no parameters; the agent's
  // reactive state (workspace, draft, currentUser) flows through the
  // registered ContentBridgeHandle, not through the store factory.
  const [store] = useState(() => createContentAgentStore())

  // Refs that follow the latest workspace + draft state on every render.
  // The bridge handle methods read through these so they always see live
  // state without forcing a re-registration each render. Same pattern as
  // the site editor's executor (which reads through a ref to the live
  // editor store).
  //
  // Updated in useLayoutEffect (not during render) per React Compiler's
  // "no ref mutation during render" rule. useLayoutEffect runs before
  // browser paint, so the next event-handler / effect callback sees the
  // freshest closure.
  const workspaceRef = useRef(workspace)
  const draftRef = useRef(draft)
  const currentUserRef = useRef(currentUser)
  useLayoutEffect(() => {
    workspaceRef.current = workspace
    draftRef.current = draft
    currentUserRef.current = currentUser
  })

  // Register the handle once on mount; tear down on unmount.
  useEffect(() => {
    const handle: ContentBridgeHandle = {
      buildSnapshot() {
        return buildSnapshotFromWorkspace(
          workspaceRef.current,
          draftRef.current,
          currentUserRef.current,
        )
      },
      listCollections() {
        return workspaceRef.current.collections.filter((t) =>
          CONTENT_KIND_VISIBLE.has(t.kind),
        )
      },
      getActiveCollectionId() {
        return workspaceRef.current.selectedCollectionId
      },
      getActiveDocument() {
        return workspaceRef.current.selectedEntry
      },
      findDocument(documentId) {
        return workspaceRef.current.entries.find((e) => e.id === documentId) ?? null
      },
      async selectDocument(documentId) {
        const ws = workspaceRef.current
        const row = ws.entries.find((e) => e.id === documentId)
        if (!row) return false
        const table = ws.collections.find((t) => t.id === row.tableId)
        if (!table || !CONTENT_KIND_VISIBLE.has(table.kind)) return false
        if (table.id !== ws.selectedCollectionId) ws.selectCollection(table.id)
        ws.selectEntry(row)
        draftRef.current.applySelectedEntry(row)
        return true
      },
      async selectCollection(tableId) {
        const ws = workspaceRef.current
        const table = ws.collections.find((t) => t.id === tableId)
        if (!table || !CONTENT_KIND_VISIBLE.has(table.kind)) return false
        ws.selectCollection(tableId)
        return true
      },
      async createDocument({ tableId, fields, status }) {
        const ws = workspaceRef.current
        const table = ws.collections.find((t) => t.id === tableId)
        if (!table || !CONTENT_KIND_VISIBLE.has(table.kind)) {
          throw new Error(`Collection ${tableId} not found.`)
        }
        // Switch to the target collection BEFORE creating — the workspace's
        // createUntitledEntry inserts into the currently-selected collection.
        if (ws.selectedCollectionId !== tableId) ws.selectCollection(tableId)
        const created = await ws.createUntitledEntry()
        if (!created) throw new Error('Failed to create document.')

        // Apply the provided fields via the draft setters so the user sees
        // them populated in the editor. Saves on next user input OR explicit
        // save — same pattern as type-and-save in the editor.
        if (fields) applyFieldsToDraft(draftRef.current, fields)
        if (fields || status) {
          // Persist via saveCmsDataRowDraft directly so the wire matches
          // what the user would do via the Save button. updateSelectedEntry
          // then refreshes the workspace's cached row.
          const cellsPatch: Record<string, unknown> = { ...created.cells, ...(fields ?? {}) }
          const saved = await saveCmsDataRowDraft(created.id, { cells: cellsPatch })
          ws.updateSelectedEntry(saved)
          if (status && status !== 'draft' && status !== saved.status) {
            await applyStatus(ws, saved, status)
          }
        }
        return created.id
      },
      async deleteDocument(documentId) {
        const ws = workspaceRef.current
        const row = ws.entries.find((e) => e.id === documentId)
        if (!row) throw new Error(`Document ${documentId} not found.`)
        await ws.deleteEntry(row)
      },
      async setDocumentStatus({ documentId, status, scheduledAt: _scheduledAt }) {
        const ws = workspaceRef.current
        const row = ws.entries.find((e) => e.id === documentId)
        if (!row) throw new Error(`Document ${documentId} not found.`)
        await applyStatus(ws, row, status)
      },
      async setDocumentField({ documentId, fieldId, value }) {
        const ws = workspaceRef.current
        if (ws.selectedEntry?.id !== documentId) {
          throw new Error(
            `Document ${documentId} is not the active doc. ` +
            'Call set_active_document first so the user can see the change.',
          )
        }
        applyFieldsToDraft(draftRef.current, { [fieldId]: value })
        await draftRef.current.handleSaveDraft()
      },
      async setDocumentFields({ documentId, fields }) {
        const ws = workspaceRef.current
        if (ws.selectedEntry?.id !== documentId) {
          throw new Error(
            `Document ${documentId} is not the active doc. ` +
            'Call set_active_document first so the user can see the change.',
          )
        }
        applyFieldsToDraft(draftRef.current, fields)
        await draftRef.current.handleSaveDraft()
      },
      async setDocumentAuthor({ documentId, userId }) {
        const ws = workspaceRef.current
        const row = ws.entries.find((e) => e.id === documentId)
        if (!row) throw new Error(`Document ${documentId} not found.`)
        await ws.updateEntryAuthor(row, userId)
      },
    }
    setContentBridgeHandle(handle)
    return () => {
      setContentBridgeHandle(null)
    }
  }, [])

  // Sync the parent-controlled `isVisible` flag into the store's
  // `isAgentOpen`. AgentPanel checks the slice flag to decide whether
  // to render its UI (it uses `display: none` via `.floatPanelClosed`
  // when closed); without this sync, the panel would stay hidden even
  // when the sidebar tab is active.
  useEffect(() => {
    if (isVisible) {
      store.getState().openAgent()
    } else {
      store.getState().closeAgent()
    }
  }, [isVisible, store])

  // AgentPanel is always-mounted (`display: none` when closed). The
  // wrapper provides the store so AgentPanel + ModelPicker +
  // ConversationHistory can read the content-scope state via
  // `useAgentStore`. The panel uses `variant="docked"` so it fills the
  // sidebar slot the same way the site editor's agent panel does — no
  // floating chrome.
  return (
    <AgentStoreProvider store={store}>
      <AgentPanel variant="docked" />
    </AgentStoreProvider>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyFieldsToDraft(
  draft: ContentAgentDraftSurface,
  fields: Record<string, unknown>,
): void {
  // Only built-in fields are wired through the draft state today.
  // Custom-field writes are a follow-up (the workspace doesn't surface a
  // generic per-field setter yet — would need to extend useContentEntryDraft
  // to hold a custom-cells map). Agent surfaces this via the "Document is
  // not the active doc" error path when fieldId isn't recognised.
  for (const [key, raw] of Object.entries(fields)) {
    switch (key) {
      case 'title':
        if (typeof raw === 'string') draft.setTitle(raw)
        break
      case 'slug':
        if (typeof raw === 'string') draft.setSlug(raw)
        break
      case 'body':
        if (typeof raw === 'string') draft.setBody(raw)
        break
      case 'seo':
        // Structured SEO object — the draft hook merges title/description
        // into `cells.seo` on save; other SEO fields are owned by the SEO
        // workspace and not editable through the content agent.
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const seo = raw as { title?: unknown; description?: unknown }
          if (typeof seo.title === 'string') draft.setSeoTitle(seo.title)
          if (typeof seo.description === 'string') draft.setSeoDescription(seo.description)
        }
        break
      case 'featuredMedia':
        if (raw === null) draft.setFeaturedMediaId(null)
        else if (typeof raw === 'string') draft.setFeaturedMediaId(raw)
        else if (
          raw && typeof raw === 'object'
          && 'id' in raw && typeof (raw as { id?: unknown }).id === 'string'
        ) draft.setFeaturedMediaId((raw as { id: string }).id)
        break
      default:
        // Unknown field — likely a custom (non-built-in) field. Throw so
        // the bridge surfaces a tool error and the agent can retry with a
        // different field id rather than silently dropping the value.
        throw new Error(
          `Field "${key}" is not editable via the agent yet. ` +
          'Only built-in fields (title, slug, body, featuredMedia, seo) ' +
          'are supported in this version.',
        )
    }
  }
}

async function applyStatus(
  ws: ContentAgentWorkspaceSurface,
  row: DataRow,
  status: 'draft' | 'unpublished' | 'published' | 'scheduled',
): Promise<void> {
  if (status === 'scheduled') {
    throw new Error(
      'Scheduled publishing is not supported via the agent yet. ' +
      'Set status to "draft" or "unpublished" first; use the schedule dialog ' +
      'in the UI to pick a publish time.',
    )
  }
  if (status === 'published') {
    const published = await publishCmsDataRow(row.id)
    ws.updateSelectedEntry(published)
    return
  }
  await ws.updateEntryStatus(row, status)
}

function buildSnapshotFromWorkspace(
  ws: ContentAgentWorkspaceSurface,
  _draft: ContentAgentDraftSurface,
  currentUser: ContentAgentCurrentUser,
): ContentAgentSnapshot {
  const collections = ws.collections
    .filter((t) => CONTENT_KIND_VISIBLE.has(t.kind))
    .map((t) => ({
      id: t.id,
      slug: t.slug,
      label: t.pluralLabel || t.name,
      kind: t.kind,
      // The workspace doesn't track per-collection doc counts in-memory
      // (only its currently-loaded `entries`). For the active collection
      // we know the exact count; for others we report 0 with a comment.
      docCount: t.id === ws.selectedCollectionId ? ws.entries.length : 0,
    }))

  const activeDocument = ws.selectedEntry
    ? projectActiveDocument(ws.selectedEntry, ws.collections)
    : null

  return {
    collections,
    activeTableId: ws.selectedCollectionId,
    activeDocument,
    currentUser,
  }
}

function projectActiveDocument(
  row: DataRow,
  collections: DataTable[],
): ContentAgentActiveDocument {
  const table = collections.find((t) => t.id === row.tableId)
  const tableFields = table ? normalizeDataTableFields(table.fields) : []
  return {
    id: row.id,
    tableId: row.tableId,
    title: readTitleCell(row.cells) || row.slug || row.id,
    slug: row.slug,
    status: row.status,
    fields: row.cells,
    schema: tableFields.map(projectField),
    authorUserId: row.authorUserId,
    updatedAt: row.updatedAt,
  }
}

function projectField(field: DataField): ContentAgentFieldInfo {
  const base: ContentAgentFieldInfo = {
    id: field.id,
    label: field.label,
    type: field.type,
    required: field.required ?? false,
    builtIn: field.builtIn ?? false,
  }
  if (field.type === 'select' || field.type === 'multiSelect') {
    return { ...base, options: field.options.map((o) => ({ value: o.id, label: o.label })) }
  }
  if (field.type === 'media') {
    return {
      ...base,
      mediaKind: field.mediaKind,
      allowMultiple: field.allowMultiple ?? false,
    }
  }
  return base
}
