import { Suspense, lazy, useEffect, useId, useRef, useState } from 'react'
import {
  readWorkspaceLayout,
  writeWorkspaceLayout,
} from '@admin/state/workspaceLayoutStorage'
import { useAdminUi } from '@admin/state/adminUi'
import { readTitleCell } from '@core/data/cells'
import type {
  DataTable,
  DataRow,
  DataRowStatus,
  UpdateDataTableInput,
} from '@core/data/schemas'
import { HeadingIcon } from 'pixel-art-icons/icons/heading'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { TextPlusIcon } from 'pixel-art-icons/icons/text-plus'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
// Token-picker dialog is awaiting re-integration with the popover-based
// DynamicBindingControl that a parallel session is rolling out. Until then
// the slash-menu "Data token" action inserts a placeholder token string at
// the caret and the author can hand-edit it.
import { AdminWorkspaceCanvasLayout } from '@admin/layouts/AdminWorkspaceCanvasLayout'
import { MediaExplorerPanel } from '@site/panels/MediaExplorerPanel'
import type { CanvasNotchAction } from '@site/canvas/CanvasNotch'
import { ContentDocumentCanvas } from './components/ContentDocumentCanvas/ContentDocumentCanvas'
import { ContentCollectionCreateDialog } from './components/ContentCollectionCreateDialog/ContentCollectionCreateDialog'
import { ContentExplorerPanel } from './components/ContentExplorerPanel/ContentExplorerPanel'
import { ContentSettingsPanel } from './components/ContentSettingsPanel/ContentSettingsPanel'
import { MediaViewerWindow } from '@admin/pages/media/components/MediaViewerWindow/MediaViewerWindow'
import { ContentSidebar, type ContentPanelId } from './components/ContentSidebar/ContentSidebar'
import { ContentToolbar } from './components/ContentToolbar/ContentToolbar'
import type { TiptapBodyEditorHandle } from './TiptapBodyEditor'
// Lazy-load the WordPress-style fullscreen media picker. Pulls in the full
// Media-page workspace (folder tree + canvas grid + upload queue), so we
// only pay for it the first time the user opens the picker — typing in the
// content editor doesn't need it.
const MediaPickerModal = lazy(() =>
  import('@admin/pages/media/components/MediaPickerModal/MediaPickerModal').then(
    (m) => ({ default: m.MediaPickerModal }),
  ),
)
import { runEntryOp, type EntryOpDeps, type EntryOpOptions } from './utils/entryOp'
import { useContentEntryDraft } from './hooks/useContentEntryDraft'
import { useContentMediaPicker } from './hooks/useContentMediaPicker'
import { useContentWorkspace } from './hooks/useContentWorkspace'
import { publicContentPath } from './utils/contentEntryUtils'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { getErrorMessage } from '@core/utils/errorMessage'
import { ContentAgentMount } from './agent/ContentAgentMount'
import {
  canCreateContent,
  canEditAnyContent,
  canEditContentEntry,
  canManageContentCollections,
  canMoveDataRow,
  canPublishContentEntry,
  canUseAiChat,
} from '@admin/access'

const CONTENT_PANEL_IDS: ReadonlySet<ContentPanelId> = new Set(['content', 'media', 'agent'])

function readPersistedContentPanel(): ContentPanelId | null {
  const stored = readWorkspaceLayout('content').activeLeftPanel
  if (stored === null) return null
  if (typeof stored === 'string' && CONTENT_PANEL_IDS.has(stored as ContentPanelId)) {
    return stored as ContentPanelId
  }
  return 'content'
}

export function ContentPage() {
  // Initial value pulls from the per-workspace stored layout so the rail
  // remembers the last panel the user had open in the Content workspace.
  // First-time visitors fall back to the 'content' panel; an explicit `null`
  // (user closed the rail) is preserved.
  const [activeContentPanel, setActiveContentPanel] = useState<ContentPanelId | null>(
    readPersistedContentPanel,
  )
  // Persist any rail change so the next visit to /admin/content reopens the
  // same panel. Effect runs on mount too — that's fine; the value is
  // identical to what we just read.
  useEffect(() => {
    writeWorkspaceLayout('content', { activeLeftPanel: activeContentPanel })
  }, [activeContentPanel])
  const [collectionDialogOpen, setCollectionDialogOpen] = useState(false)
  // These are monotonic counters used purely as "do the action now" pings:
  // bumping them re-runs the focus effect inside the canvas / body editor.
  const [focusTitleSignal, setFocusTitleSignal] = useState(0)
  const [focusBodySignal, setFocusBodySignal] = useState(0)
  // Token binding picker — temporarily stubbed (see comment near
  // `BindingPickerPopover` placeholder below). Slash-menu / notch actions
  // insert a placeholder token directly until the popover is wired up to
  // the body editor's caret.
  // Canvas display mode: 'write' is the bare editor surface, 'live' is
  // the entry rendered inside its template (real site styles, inline
  // editing). Switching is purely client-side — the body markdown is the
  // source of truth, so both modes show the same content.
  const [contentMode, setContentMode] = useState<'write' | 'live'>('write')
  const slugId = useId()
  const seoTitleId = useId()
  const seoDescriptionId = useId()

  // Imperative handle into the body editor — let us focus, insert text
  // (data tokens), insert media nodes, or append heading/paragraph blocks
  // from outside the editor in response to notch / picker actions.
  const bodyEditorRef = useRef<TiptapBodyEditorHandle | null>(null)

  // Strict accessor — ContentPage only renders inside `AuthenticatedAdmin`,
  // which gates the entire tree on a non-null session user. A null here
  // means the page rendered outside an `AdminSessionProvider`, which is a
  // programming error, not a permission state — fail loud, don't fail
  // open. (The previous code path silently treated null as an unrestricted
  // sentinel, which masked tests that forgot to wire the provider and
  // briefly painted full-admin UI in any session-rehydration race.)
  const permissionUser = useAuthenticatedAdminUser()
  const canReassignAuthor = canEditAnyContent(permissionUser)
  const canCreateEntries = canCreateContent(permissionUser)
  const canManageCollections = canManageContentCollections(permissionUser)
  const canUseAgent = canUseAiChat(permissionUser)
  const visibleContentPanel = activeContentPanel === 'agent' && !canUseAgent
    ? null
    : activeContentPanel
  const workspace = useContentWorkspace({ loadAuthors: canReassignAuthor })
  // Collection schema mutations (create/update/delete) are step-up gated on
  // the server — they change the public route surface — so they must run
  // through `runStepUp`, which transparently opens the password re-entry
  // dialog on a `step_up_required` response and retries. Without this the
  // raw `step_up_required` error leaks into the dialog as visible text.
  const { runStepUp } = useStepUp()
  const draft = useContentEntryDraft({
    selectedEntry: workspace.selectedEntry,
    updateSelectedEntry: workspace.updateSelectedEntry,
    setError: workspace.setError,
  })
  const mediaPicker = useContentMediaPicker({
    featuredMediaId: draft.featuredMediaId,
    setFeaturedMediaId: draft.setFeaturedMediaId,
    insertBodyMedia: (attrs) => bodyEditorRef.current?.insertMedia(attrs),
    entries: workspace.entries,
  })

  const publicPath = workspace.selectedCollection && draft.slug
    ? publicContentPath(workspace.selectedCollection.routeBase, draft.slug)
    : ''
  const canEditSelectedEntry = canEditContentEntry(permissionUser, workspace.selectedEntry)
  const canMoveRows = canMoveDataRow(permissionUser)
  const canMoveSelectedEntry = canEditSelectedEntry && canMoveRows
  const canPublishSelectedEntry = canPublishContentEntry(permissionUser, workspace.selectedEntry)

  // Mirror the selected entry's public URL into adminUi so the global
  // toolbar's "Open live page" icon button deep-links to the post the
  // user is editing — instead of the site root (Site editor publishes
  // its own active-page path; here we publish the entry's path). Empty
  // string (no entry / no slug yet) maps to null so the button falls
  // back to the site root.
  const publishActiveLivePath = useAdminUi((s) => s.setActiveLivePath)
  useEffect(() => {
    publishActiveLivePath(publicPath || null)
    return () => {
      publishActiveLivePath(null)
    }
  }, [publicPath, publishActiveLivePath])

  // Note: we used to unconditionally `setPropertiesPanel({ collapsed:
  // false })` here on mount, which forced the inspector open every time
  // the user entered the Content workspace — overriding the saved
  // closed state and causing a slide-in width transition on the right
  // sidebar. The persisted layout in localStorage is the source of
  // truth; if the user closed the inspector, it stays closed when they
  // return. Specific actions (selecting an entry, opening a row) still
  // open the inspector through their own handlers.

  // Bind the save-state machine to this page's setters once. Every entry
  // handler runs through `withEntryOp`, which owns the
  // permission-check → saving → try → apply → saved/error sequence so a
  // handler can never leave the toolbar stuck on "Saving…".
  const entryOpDeps: EntryOpDeps = {
    setSaveMessage: draft.setSaveMessage,
    setError: workspace.setError,
  }
  function withEntryOp<T>(fn: () => Promise<T>, options: EntryOpOptions<T>) {
    return runEntryOp(entryOpDeps, fn, options)
  }
  const SAVE_PHASE = { pending: 'saving', done: 'saved' } as const

  function handleCreateEntry() {
    return withEntryOp(() => workspace.createUntitledEntry(), {
      permitted: canCreateEntries,
      permMsg: 'Your role cannot create content entries',
      fallback: 'Could not create entry',
      phase: SAVE_PHASE,
      // `createUntitledEntry` hands us an entry whose title is empty so the
      // editor's title field renders as a placeholder rather than pre-filling
      // "Untitled" (the server-side fallback the sidebar list still shows).
      apply: (entry) => {
        draft.applySelectedEntry(entry)
        setFocusTitleSignal((n) => n + 1)
      },
    })
  }

  function handleMoveEntryCollection(tableId: string) {
    return withEntryOp(() => workspace.moveSelectedEntryToCollection(tableId), {
      permitted: canMoveSelectedEntry,
      permMsg: 'Your role cannot move this entry',
      fallback: 'Could not move entry',
      phase: SAVE_PHASE,
      apply: (entry) => { if (entry) draft.applySelectedEntry(entry) },
    })
  }

  function handleUpdateEntryAuthor(authorUserId: string) {
    const entry = workspace.selectedEntry
    if (!entry || entry.authorUserId === authorUserId) return Promise.resolve()
    return withEntryOp(() => workspace.updateEntryAuthor(entry, authorUserId), {
      permitted: canReassignAuthor,
      permMsg: 'Your role cannot reassign authors',
      fallback: 'Could not update author',
      phase: SAVE_PHASE,
      apply: (updatedEntry) => draft.applySelectedEntry(updatedEntry),
    })
  }

  // Collection update/delete are step-up gated, so they bypass `withEntryOp`
  // (whose generic catch would surface a step-up *cancellation* as a visible
  // error). Instead they run through `runStepUp` directly and let the calling
  // settings dialog render real errors; a cancellation is a silent no-op.
  async function handleUpdateCollection(
    collection: DataTable,
    input: UpdateDataTableInput,
  ) {
    if (!canManageCollections) {
      workspace.setError('Your role cannot manage content collections')
      return
    }
    workspace.setError(null)
    // Rejections propagate to the settings dialog, which keeps itself open and
    // renders the message (and swallows `step_up_cancelled`).
    await runStepUp(() => workspace.updateCollection(collection.id, input))
  }

  async function handleDeleteCollection(collection: DataTable) {
    if (!canManageCollections) {
      workspace.setError('Your role cannot manage content collections')
      return
    }
    workspace.setError(null)
    try {
      await runStepUp(() => workspace.deleteCollection(collection.id))
      if (workspace.selectedCollectionId === collection.id) {
        draft.applySelectedEntry(null)
      }
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      workspace.setError(getErrorMessage(err, 'Could not delete collection'))
    }
  }

  function handleRenameEntry(
    entry: DataRow,
    input: { title: string; slug: string },
  ) {
    return withEntryOp(() => {
      const entrySnapshot = workspace.selectedEntry?.id === entry.id
        ? {
            ...entry,
            cells: {
              ...entry.cells,
              ...draft.customCells,
              body: draft.body,
              featuredMedia: draft.featuredMediaId,
              seoTitle: draft.seoTitle,
              seoDescription: draft.seoDescription,
            },
          }
        : entry
      return workspace.renameEntry(entrySnapshot, input)
    }, {
      permitted: canEditContentEntry(permissionUser, entry),
      permMsg: 'Your role cannot edit this entry',
      fallback: 'Could not rename entry',
      phase: SAVE_PHASE,
      rethrow: true,
      apply: (updatedEntry) => {
        if (workspace.selectedEntry?.id === entry.id) {
          draft.applySelectedEntry(updatedEntry)
        }
      },
    })
  }

  function handleDeleteEntry(entry: DataRow) {
    return withEntryOp(() => workspace.deleteEntry(entry), {
      permitted: canEditContentEntry(permissionUser, entry),
      permMsg: 'Your role cannot delete this entry',
      fallback: 'Could not delete entry',
      rethrow: true,
      apply: (nextEntry) => {
        if (workspace.selectedEntry?.id === entry.id) {
          draft.applySelectedEntry(nextEntry)
        }
      },
    })
  }

  function handleDuplicateEntry(entry: DataRow) {
    return withEntryOp(() => {
      // If duplicating the currently-edited entry, capture the in-memory draft
      // so the duplicate reflects the latest unsaved edits instead of the
      // last-saved body — the user clicked duplicate on the row they can see.
      const source = workspace.selectedEntry?.id === entry.id
        ? {
            ...entry,
            cells: {
              ...entry.cells,
              ...draft.customCells,
              body: draft.body,
              featuredMedia: draft.featuredMediaId,
              seoTitle: draft.seoTitle,
              seoDescription: draft.seoDescription,
              title: draft.title || readTitleCell(entry.cells),
            },
          }
        : entry
      return workspace.duplicateEntry(source)
    }, {
      permitted: canCreateEntries,
      permMsg: 'Your role cannot create content entries',
      fallback: 'Could not duplicate entry',
      phase: SAVE_PHASE,
      rethrow: true,
      apply: (duplicated) => draft.applySelectedEntry(duplicated),
    })
  }

  function handleMoveEntryToCollection(entry: DataRow, tableId: string) {
    if (entry.tableId === tableId) return Promise.resolve()
    return withEntryOp(() => workspace.moveEntryToCollection(entry, tableId), {
      permitted: canMoveRows && canEditContentEntry(permissionUser, entry),
      permMsg: 'Your role cannot move this entry',
      fallback: 'Could not move entry',
      rethrow: true,
      apply: (updatedEntry) => {
        if (workspace.selectedEntry?.id === entry.id) {
          draft.applySelectedEntry(updatedEntry)
        }
      },
    })
  }

  async function handlePublishEntry(entry: DataRow) {
    if (!canPublishContentEntry(permissionUser, entry)) {
      workspace.setError('Your role cannot publish this entry')
      return
    }

    if (workspace.selectedEntry?.id === entry.id) {
      if (canEditContentEntry(permissionUser, entry)) {
        await draft.handlePublish()
      } else {
        await withEntryOp(() => workspace.publishEntry(entry), {
          fallback: 'Could not publish entry',
          phase: { pending: 'publishing', done: 'published' },
          apply: (published) => draft.applySelectedEntry(published),
        })
      }
      return
    }

    await withEntryOp(() => workspace.publishEntry(entry), {
      fallback: 'Could not publish entry',
      rethrow: true,
    })
  }

  async function handleStatusChange(status: DataRowStatus) {
    const entry = workspace.selectedEntry
    if (!entry || status === entry.status) return

    if (status === 'published') {
      await handlePublishEntry(entry)
      return
    }

    if (!canEditContentEntry(permissionUser, entry)) {
      workspace.setError('Your role cannot edit this entry')
      return
    }

    await draft.handleStatusChange(status)
  }

  function handleScheduleEntry(entry: DataRow) {
    workspace.updateSelectedEntry(entry)
    draft.applySelectedEntry(entry)
  }

  async function handleConvertEntryToDraft(entry: DataRow) {
    if (!canEditContentEntry(permissionUser, entry)) {
      workspace.setError('Your role cannot edit this entry')
      return
    }
    if (workspace.selectedEntry?.id === entry.id) {
      await draft.handleStatusChange('draft')
      return
    }

    await withEntryOp(() => workspace.updateEntryStatus(entry, 'draft'), {
      fallback: 'Could not convert entry to draft',
      rethrow: true,
    })
  }

  function handleSelectEntry(entry: Parameters<typeof workspace.selectEntry>[0]) {
    workspace.selectEntry(entry)
    draft.applySelectedEntry(entry)
  }

  const notchActions: CanvasNotchAction[] = [
    {
      id: 'heading',
      label: 'Heading',
      icon: HeadingIcon,
      onClick: () => bodyEditorRef.current?.appendBlock('heading'),
    },
    {
      id: 'text',
      label: 'Text',
      icon: TextPlusIcon,
      onClick: () => bodyEditorRef.current?.appendBlock('paragraph'),
    },
    {
      id: 'media',
      label: 'Media',
      icon: ImagesSolidIcon,
      onClick: () => void mediaPicker.openMediaPicker('media'),
    },
    {
      id: 'bind',
      label: 'Insert data token',
      icon: BracesIcon,
      onClick: () => bodyEditorRef.current?.insertText('{currentEntry.title}'),
    },
  ]

  return (
    <>
      <AdminWorkspaceCanvasLayout
        workspace="content"
        toolbarRightSlot={(
          <ContentToolbar
            contentLoading={workspace.contentLoading}
            saveMessage={draft.saveMessage}
            isDirty={draft.isDirty}
            selectedEntry={workspace.selectedEntry}
            selectedCollection={workspace.selectedCollection}
            publicPath={publicPath}
            canSaveDraft={canEditSelectedEntry}
            canPublish={canPublishSelectedEntry}
            onSaveDraft={() => void draft.handleSaveDraft()}
            onPublish={() => {
              if (workspace.selectedEntry) void handlePublishEntry(workspace.selectedEntry)
            }}
            onSchedule={handleScheduleEntry}
          />
        )}
        contentSidebar={(
          <ContentSidebar
            activePanel={visibleContentPanel}
            onActivePanelChange={(panel) => {
              if (panel === 'agent' && !canUseAgent) return
              setActiveContentPanel(panel)
            }}
            contentPanel={(
              <ContentExplorerPanel
                loading={workspace.contentLoading}
                error={workspace.error}
                collections={workspace.collections}
                entries={workspace.entries}
                selectedCollection={workspace.selectedCollection}
                selectedCollectionId={workspace.selectedCollectionId}
                selectedEntryId={workspace.selectedEntry?.id ?? null}
                canCreateCollection={canManageCollections}
                canCreateEntry={canCreateEntries}
                canManageCollections={canManageCollections}
                canEditEntry={(entry) => canEditContentEntry(permissionUser, entry)}
                canMoveEntry={(entry) => canMoveRows && canEditContentEntry(permissionUser, entry)}
                canPublishEntry={(entry) => canPublishContentEntry(permissionUser, entry)}
                getFeaturedMediaAssetForEntry={mediaPicker.getFeaturedMediaAssetForEntry}
                onSelectCollection={workspace.selectCollection}
                onSelectEntry={handleSelectEntry}
                entryActions={{
                  createCollection: () => setCollectionDialogOpen(true),
                  updateCollection: handleUpdateCollection,
                  deleteCollection: handleDeleteCollection,
                  createEntry: () => void handleCreateEntry(),
                  renameEntry: handleRenameEntry,
                  publishEntry: handlePublishEntry,
                  convertEntryToDraft: handleConvertEntryToDraft,
                  deleteEntry: handleDeleteEntry,
                  duplicateEntry: handleDuplicateEntry,
                  moveEntryToCollection: handleMoveEntryToCollection,
                }}
                onClose={() => setActiveContentPanel(null)}
              />
            )}
            mediaPanel={(
              <MediaExplorerPanel
                variant="docked"
                open={activeContentPanel === 'media'}
                onOpenChange={(open) => setActiveContentPanel(open ? 'media' : null)}
              />
            )}
            agentPanel={(
              <ContentAgentMount
                workspace={workspace}
                draft={draft}
                currentUser={{
                  id: permissionUser.id,
                  displayName: permissionUser.displayName ?? permissionUser.email,
                  email: permissionUser.email,
                }}
                isVisible={visibleContentPanel === 'agent'}
              />
            )}
            canUseAiChat={canUseAgent}
          />
        )}
        contentCanvas={(
          <ContentDocumentCanvas
            ref={bodyEditorRef}
            selectedEntry={workspace.selectedEntry}
            selectedCollection={workspace.selectedCollection}
            loading={workspace.contentLoading}
            title={draft.title}
            body={draft.body}
            notchActions={notchActions}
            canEditEntry={canEditSelectedEntry}
            canCreateEntry={canCreateEntries}
            focusTitleSignal={focusTitleSignal}
            focusBodySignal={focusBodySignal}
            contentMode={contentMode}
            onContentModeChange={setContentMode}
            onTitleChange={draft.setTitle}
            onTitleEnter={() => setFocusBodySignal((n) => n + 1)}
            onBodyChange={draft.setBody}
            onPickMedia={() => mediaPicker.openMediaPicker('media')}
            onInsertDataToken={() => bodyEditorRef.current?.insertText('{currentEntry.title}')}
            onCreateEntry={() => void handleCreateEntry()}
          />
        )}
        contentRightPanel={workspace.selectedEntry ? (
          <ContentSettingsPanel
            selectedEntry={workspace.selectedEntry}
            authors={workspace.authors}
            authorsLoading={workspace.authorsLoading}
            collections={workspace.collections}
            tables={workspace.tables}
            selectedCollection={workspace.selectedCollection}
            loading={workspace.contentLoading}
            slug={draft.slug}
            slugId={slugId}
            seoTitle={draft.seoTitle}
            seoTitleId={seoTitleId}
            seoDescription={draft.seoDescription}
            seoDescriptionId={seoDescriptionId}
            publicPath={publicPath}
            mediaError={mediaPicker.mediaError}
            featuredMediaId={draft.featuredMediaId}
            featuredMediaAsset={mediaPicker.featuredMediaAsset}
            customCells={draft.customCells}
            onCollectionChange={(tableId) => void handleMoveEntryCollection(tableId)}
            onAuthorChange={(authorUserId) => void handleUpdateEntryAuthor(authorUserId)}
            onSlugChange={draft.setSlug}
            onSeoTitleChange={draft.setSeoTitle}
            onSeoDescriptionChange={draft.setSeoDescription}
            onCustomCellChange={draft.setCustomCell}
            onStatusChange={(status) => void handleStatusChange(status)}
            onChooseFeaturedMedia={() => void mediaPicker.openMediaPicker('featured')}
            onClearFeaturedMedia={() => draft.setFeaturedMediaId(null)}
            onEditFeaturedMedia={() => {
              if (mediaPicker.featuredMediaAsset) {
                mediaPicker.openMediaViewer(mediaPicker.featuredMediaAsset.id)
              }
            }}
            canEditEntry={canEditSelectedEntry}
            canMoveEntry={canMoveSelectedEntry}
            canPublishEntry={canPublishSelectedEntry}
            canChangeAuthor={canReassignAuthor}
          />
        ) : undefined}
      />

      {mediaPicker.mediaPicker && (
        <Suspense fallback={null}>
          <MediaPickerModal
            open
            onClose={mediaPicker.closeMediaPicker}
            mediaKind="any"
            currentValue={mediaPicker.mediaPicker.kind === 'featured'
              ? (mediaPicker.featuredMediaAsset?.publicPath ?? null)
              : null}
            onPick={mediaPicker.pickMedia}
          />
        </Suspense>
      )}

      <MediaViewerWindow
        editor={mediaPicker.viewerEditor}
        open={mediaPicker.viewerOpen}
        onClose={mediaPicker.closeMediaViewer}
      />


      {collectionDialogOpen && (
        <ContentCollectionCreateDialog
          onCancel={() => setCollectionDialogOpen(false)}
          onCreate={async (input) => {
            if (!canManageCollections) {
              workspace.setError('Your role cannot manage content collections')
              setCollectionDialogOpen(false)
              return
            }
            // On a step-up cancellation `runStepUp` rejects before this line,
            // so the dialog stays open (it swallows `step_up_cancelled`).
            await runStepUp(() => workspace.createCollection(input))
            setCollectionDialogOpen(false)
          }}
        />
      )}

      {/*
        Token binding picker — temporarily stubbed. When the popover-based
        BindingPickerPopover wires up to the body editor's caret rect,
        mount it here anchored to a stable wrapper element and forward the
        chosen token to `bodyEditorRef.current?.insertText`.
      */}
    </>
  )
}
