/**
 * Register the Content workspace's imperative tool surface and keep its MCP
 * relay connected for the entire ContentPage mount. This deliberately lives
 * outside ContentAgentMount: opening or closing the AI panel must not decide
 * whether an external MCP client can reach the already-open workspace.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { readDisplayTitle } from '@core/data/cells'
import { normalizeDataTableFields } from '@core/data/fields'
import type { DataField, DataRow, DataTable } from '@core/data/schemas'
import {
  createCmsDataRow,
  getCmsDataRow,
  publishCmsDataRow,
  saveCmsDataRowDraft,
  scheduleCmsDataRowPublish,
} from '@core/persistence'
import { useMcpWorkspaceBridge } from '@admin/ai/useMcpWorkspaceBridge'
import { executeContentTool } from './contentBridge'
import {
  setContentBridgeHandle,
  type ContentAgentActiveDocument,
  type ContentAgentCurrentUser,
  type ContentAgentFieldInfo,
  type ContentAgentSnapshot,
  type ContentBridgeHandle,
} from './contentBridgeHandle'

// `page`, `data` (custom tables), and `component` definitions belong to other
// workspaces. Keep the bridge aligned with the Content workspace collection list.
const CONTENT_KIND_VISIBLE: ReadonlySet<string> = new Set(['postType'])

/** Where a table this workspace cannot author is actually edited. */
const KIND_HOME: Record<string, string> = {
  data: 'the Data workspace — write its rows with data_create_rows / data_update_row',
  page: 'the Site editor — use the site_* tools',
  component: 'the Site editor — use the site_* tools',
  layout: 'the Site editor — use the site_* tools',
}

/**
 * Why a table id the Content workspace was handed is not usable here.
 *
 * Reads the roster the bridge already has rather than asking the server, so a
 * refusal stays a refusal and never turns into a network error of its own.
 */
function unusableCollectionMessage(tableId: string, table: DataTable | undefined): string {
  const home = table && KIND_HOME[table.kind]
  if (!table || !home) return `Collection ${tableId} not found.`
  return `Table "${table.slug}" is a ${table.kind} table, not a post type: it is edited in ${home}.`
}

interface ContentToolWorkspaceSurface {
  /** Post types only — what the sidebar lists and what this bridge can author. */
  collections: DataTable[]
  /** Every table, including the ones other workspaces own. Used to explain refusals. */
  tables: DataTable[]
  /** Re-reads the roster from the server and returns every table. */
  refreshTables(): Promise<DataTable[]>
  entries: DataRow[]
  selectedEntry: DataRow | null
  selectedCollectionId: string | null
  selectCollection(tableId: string): void
  openEntry(entry: DataRow): boolean
  deleteEntry(entry: DataRow): Promise<DataRow | null>
  updateEntryStatus(entry: DataRow, status: 'draft' | 'unpublished'): Promise<DataRow>
  updateEntryAuthor(entry: DataRow, userId: string): Promise<DataRow>
  updateSelectedEntry(entry: DataRow): void
  /** Refresh a row, selecting it only if it is already the active document. */
  applyEntryUpdate(entry: DataRow): void
}

interface ContentToolDraftSurface {
  setTitle(value: string): void
  setSlug(value: string): void
  setSeoTitle(value: string): void
  setSeoDescription(value: string): void
  setFeaturedMediaId(value: string | null): void
  setBody(value: string): void
  setCustomCell(fieldId: string, value: unknown): void
  applySelectedEntry(entry: DataRow | null): void
}

interface UseContentToolBridgeOptions {
  workspace: ContentToolWorkspaceSurface
  draft: ContentToolDraftSurface
  currentUser: ContentAgentCurrentUser
}

export function useContentToolBridge({
  workspace,
  draft,
  currentUser,
}: UseContentToolBridgeOptions): void {
  const workspaceRef = useRef(workspace)
  const draftRef = useRef(draft)
  const currentUserRef = useRef(currentUser)

  useLayoutEffect(() => {
    workspaceRef.current = workspace
    draftRef.current = draft
    currentUserRef.current = currentUser
  })

  useEffect(() => {
    /**
     * Find a Content-visible collection, refreshing the roster once if the id
     * is unknown, and throwing a message that says why when it stays unusable.
     *
     * The workspace caches its collections at mount, so a table created after
     * that — by an import, another admin, or an MCP connector building a site
     * — is invisible here and every write against it fails with "not found"
     * until someone reloads the page. One refresh distinguishes "created a
     * moment ago" from "does not exist".
     *
     * The refusal is kind-aware because "not found" was actively wrong for the
     * commonest miss: a reusable `kind: 'data'` table exists, the caller has
     * the right id, and it simply is not authored in this Tiptap editor. Agents
     * responded by re-creating the table (issue #463). Name the mismatch and
     * point at the toolset that can write it instead.
     */
    const resolveCollection = async (tableId: string): Promise<DataTable> => {
      const cached = workspaceRef.current.collections.find((c) => c.id === tableId)
      if (cached) return cached

      // The refresh returns every table, so a miss here can say WHICH kind of
      // table this is without a second request.
      const refreshed = await workspaceRef.current.refreshTables()
      const found = refreshed.find((candidate) => candidate.id === tableId)
      if (found && CONTENT_KIND_VISIBLE.has(found.kind)) return found

      throw new Error(unusableCollectionMessage(tableId, found))
    }

    const handle: ContentBridgeHandle = {
      buildSnapshot() {
        return buildSnapshotFromWorkspace(
          workspaceRef.current,
          currentUserRef.current,
        )
      },
      async selectDocument(documentId) {
        const cached = workspaceRef.current.entries.find((entry) => entry.id === documentId)
        const row = cached ?? await getCmsDataRow(documentId)
        if (!row) return false

        // Re-read after the fetch: the user may have navigated while the row
        // request was in flight. Only Content-owned post-type rows are valid.
        const ws = workspaceRef.current
        const table = ws.collections.find((candidate) => candidate.id === row.tableId)
        if (!table || !CONTENT_KIND_VISIBLE.has(table.kind)) return false

        let opened = false
        // External MCP calls can arrive back-to-back without giving React a
        // render turn. Commit the workspace + draft focus before reporting
        // success so the next tool observes this document as active.
        flushSync(() => {
          opened = ws.openEntry(row)
          if (opened) draftRef.current.applySelectedEntry(row)
        })
        return opened
      },
      async selectCollection(tableId) {
        await resolveCollection(tableId)
        flushSync(() => workspaceRef.current.selectCollection(tableId))
      },
      async createDocument({ tableId, fields }) {
        await resolveCollection(tableId)
        const cells = fields ? normalizeEditableFields(fields) : {}
        // Create directly in the requested collection. The manual
        // createUntitledEntry action is intentionally tied to the currently
        // selected collection; using it here after setState would still read
        // the previous render and could insert into the wrong table.
        const created = await createCmsDataRow(tableId, { cells })
        const latestWorkspace = workspaceRef.current
        let opened = false
        flushSync(() => {
          opened = latestWorkspace.openEntry(created)
          if (opened) draftRef.current.applySelectedEntry(created)
        })
        if (!opened) {
          const known = workspaceRef.current.tables.find((t) => t.id === tableId)
          throw new Error(unusableCollectionMessage(tableId, known))
        }
        return created.id
      },
      async deleteDocument(documentId) {
        const ws = workspaceRef.current
        const row = ws.entries.find((entry) => entry.id === documentId)
        if (!row) throw new Error(`Document ${documentId} not found.`)
        await ws.deleteEntry(row)
      },
      async setDocumentStatus({ documentId, status, scheduledAt }) {
        const ws = workspaceRef.current
        const row = ws.entries.find((entry) => entry.id === documentId)
        if (!row) throw new Error(`Document ${documentId} not found.`)
        await applyStatus(ws, row, status, scheduledAt)
      },
      async setDocumentField({ documentId, fieldId, value }) {
        await saveDocumentFields(
          workspaceRef.current,
          draftRef.current,
          documentId,
          { [fieldId]: value },
        )
      },
      async setDocumentFields({ documentId, fields }) {
        await saveDocumentFields(
          workspaceRef.current,
          draftRef.current,
          documentId,
          fields,
        )
      },
      async setDocumentAuthor({ documentId, userId }) {
        const ws = workspaceRef.current
        const row = ws.entries.find((entry) => entry.id === documentId)
        if (!row) throw new Error(`Document ${documentId} not found.`)
        await ws.updateEntryAuthor(row, userId)
      },
    }

    setContentBridgeHandle(handle)
    return () => {
      setContentBridgeHandle(null)
    }
  }, [])

  useMcpWorkspaceBridge('content', executeContentTool)
}

async function saveDocumentFields(
  ws: ContentToolWorkspaceSurface,
  draft: ContentToolDraftSurface,
  documentId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const row = ws.entries.find((entry) => entry.id === documentId)
  if (!row || ws.selectedEntry?.id !== documentId) {
    throw new Error(
      `Document ${documentId} is not the active doc. ` +
      'Call set_active_document first so the user can see the change.',
    )
  }

  // Validate the editable surface before persisting. Saving directly from the
  // row avoids React state batching: calling setters and then a closure-based
  // save in the same tick would otherwise write the previous field values.
  const cells = normalizeEditableFields(fields)
  applyFieldsToDraft(draft, cells)
  const saved = await saveCmsDataRowDraft(row.id, {
    cells: { ...row.cells, ...cells },
  })
  ws.updateSelectedEntry(saved)
  draft.applySelectedEntry(saved)
}

function normalizeEditableFields(fields: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'featuredMedia') {
      if (value === null || typeof value === 'string') {
        normalized[key] = value
        continue
      }
      if (
        typeof value === 'object'
        && 'id' in value
        && typeof (value as { id?: unknown }).id === 'string'
      ) {
        normalized[key] = (value as { id: string }).id
        continue
      }
      throw new Error('Field "featuredMedia" must be a media id, { id }, or null.')
    }
    if (['title', 'slug', 'body', 'seoTitle', 'seoDescription'].includes(key)) {
      if (typeof value === 'string') {
        normalized[key] = value
        continue
      }
      throw new Error(`Field "${key}" must be a string.`)
    }
    normalized[key] = value
  }
  return normalized
}

function applyFieldsToDraft(
  draft: ContentToolDraftSurface,
  fields: Record<string, unknown>,
): void {
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
      case 'seoTitle':
        if (typeof raw === 'string') draft.setSeoTitle(raw)
        break
      case 'seoDescription':
        if (typeof raw === 'string') draft.setSeoDescription(raw)
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
        draft.setCustomCell(key, raw)
    }
  }
}

/**
 * Publish/schedule a row without moving the active document.
 *
 * `updateSelectedEntry` sets `selectedEntry`, so calling it for a row that is
 * NOT the active one silently retargets the workspace. Two things went wrong
 * with that. A caller looping `set_document_fields` → `set_document_status`
 * over several documents left the active pointer one step behind itself, and
 * the field writes — which require the active document — then failed on every
 * document after the first. And it yanked whatever a human had open, taking
 * their unsaved draft with it, because `useContentEntryDraft` re-applies on a
 * `selectedEntry` id change.
 *
 * The non-agent paths already guard this way (`useContentWorkspace`'s
 * `updateEntryStatus` / `updateEntryAuthor`); this brings the agent path in
 * line rather than leaving the two asymmetric.
 */
async function applyStatus(
  ws: ContentToolWorkspaceSurface,
  row: DataRow,
  status: 'draft' | 'unpublished' | 'published' | 'scheduled',
  scheduledAt?: string,
): Promise<void> {
  if (status === 'scheduled') {
    if (!scheduledAt) throw new Error('scheduledAt is required for scheduled publishing.')
    ws.applyEntryUpdate(await scheduleCmsDataRowPublish(row.id, scheduledAt))
    return
  }
  if (status === 'published') {
    ws.applyEntryUpdate(await publishCmsDataRow(row.id))
    return
  }
  await ws.updateEntryStatus(row, status)
}

function buildSnapshotFromWorkspace(
  ws: ContentToolWorkspaceSurface,
  currentUser: ContentAgentCurrentUser,
): ContentAgentSnapshot {
  const collections = ws.collections
    .filter((table) => CONTENT_KIND_VISIBLE.has(table.kind))
    .map((table) => ({
      id: table.id,
      slug: table.slug,
      label: table.pluralLabel || table.name,
      kind: table.kind,
      docCount: table.id === ws.selectedCollectionId ? ws.entries.length : 0,
    }))

  return {
    collections,
    activeTableId: ws.selectedCollectionId,
    activeDocument: ws.selectedEntry
      ? projectActiveDocument(ws.selectedEntry, ws.collections)
      : null,
    currentUser,
  }
}

function projectActiveDocument(
  row: DataRow,
  collections: DataTable[],
): ContentAgentActiveDocument {
  const table = collections.find((candidate) => candidate.id === row.tableId)
  const tableFields = table ? normalizeDataTableFields(table.fields) : []
  return {
    id: row.id,
    tableId: row.tableId,
    title: readDisplayTitle(row.cells, table),
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
    return {
      ...base,
      options: field.options.map((option) => ({
        value: option.id,
        label: option.label,
      })),
    }
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
