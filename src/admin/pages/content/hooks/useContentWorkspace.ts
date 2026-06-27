import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createCmsDataRow,
  createCmsDataTable,
  deleteCmsDataRow,
  deleteCmsDataTable,
  listCmsDataAuthors,
  listCmsDataRows,
  listCmsDataTables,
  publishCmsDataRow,
  saveCmsDataRowDraft,
  updateCmsDataRowAuthor,
  updateCmsDataRowTable,
  updateCmsDataTable,
  updateCmsDataRowStatus,
} from '@core/persistence'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'
import type {
  DataTable,
  DataRow,
  DataUserReference,
  CreateDataTableInput,
  UpdateDataTableInput,
} from '@core/data/schemas'
import {
  readBodyCell,
  readFeaturedMediaCell,
} from '@core/data/cells'
import { buildDuplicateRowCells } from '@core/data/duplicateRow'
import { updateRowList } from '@content/utils/contentEntryUtils'
import { useInitialQueryParams, useUrlQuerySync } from '@admin/lib/urlState'
import { getErrorMessage } from '@core/utils/errorMessage'

interface UseContentWorkspaceOptions {
  loadAuthors?: boolean
}

export function useContentWorkspace({
  loadAuthors: shouldLoadAuthors = true,
}: UseContentWorkspaceOptions = {}) {
  const setRightPanel = useWorkspaceLayout((s) => s.setRightPanel)
  const [collections, setCollections] = useState<DataTable[]>([])
  const [entries, setEntries] = useState<DataRow[]>([])
  const [authors, setAuthors] = useState<DataUserReference[]>([])
  const [authorsLoading, setAuthorsLoading] = useState(true)
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [selectedEntry, setSelectedEntry] = useState<DataRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [entriesLoading, setEntriesLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Capture the deep-link query params present at mount once — later
  // replaceState writes (from the URL sync below) don't change what the
  // one-shot deep-link reads. Held in refs so the deep-link effects read
  // imperative values rather than reactive state.
  const initialParams = useInitialQueryParams()
  const initialTableSlugRef = useRef(initialParams.get('table'))
  const initialRowIdRef = useRef(initialParams.get('row'))
  // Prevent the one-shot deep-link from firing more than once per mount.
  const deepLinkAppliedRef = useRef(false)
  // Set by deep-link effect A; consumed and cleared by effect B.
  const pendingDeepLinkRef = useRef<{ rowId: string | null } | null>(null)

  const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) ?? null
  const contentLoading = loading || entriesLoading

  // Exception #1: referenced in deep-link effect B's dependency array, so it
  // needs a stable identity for react-hooks/exhaustive-deps.
  const selectEntry = useCallback((entry: DataRow | null) => {
    setSelectedEntry(entry)
    if (entry) setRightPanel({ collapsed: false })
  }, [setRightPanel])

  useEffect(() => {
    let cancelled = false

    async function fetchAuthors() {
      if (!shouldLoadAuthors) {
        setAuthors([])
        setAuthorsLoading(false)
        return
      }
      setAuthorsLoading(true)
      try {
        const nextAuthors = await listCmsDataAuthors()
        if (!cancelled) setAuthors(nextAuthors)
      } catch (_err) {
        // Author reassignment is optional; keep the editor usable if this
        // auxiliary candidate list is unavailable.
        if (!cancelled) setAuthors([])
      } finally {
        if (!cancelled) setAuthorsLoading(false)
      }
    }

    void fetchAuthors()
    return () => { cancelled = true }
  }, [shouldLoadAuthors])

  const updateSelectedEntry = (entry: DataRow) => {
    setSelectedEntry(entry)
    setEntries((current) => updateRowList(current, entry))
  }

  useEffect(() => {
    let cancelled = false

    async function loadCollections() {
      setLoading(true)
      setEntriesLoading(true)
      setError(null)
      try {
        // Only show post-type tables in the Content page sidebar.
        const allTables = await listCmsDataTables()
        const nextCollections = allTables.filter((table) => table.kind === 'postType')
        if (cancelled) return
        const fallbackCollectionId = nextCollections[0]?.id ?? null
        setCollections(nextCollections)
        setEntriesLoading(Boolean(fallbackCollectionId))
        setSelectedCollectionId((current) => current ?? fallbackCollectionId)
      } catch (err) {
        if (!cancelled) {
          setEntriesLoading(false)
          setError(getErrorMessage(err, 'Could not load content'))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadCollections()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!selectedCollectionId) {
      let cancelled = false
      queueMicrotask(() => {
        if (!cancelled) setEntriesLoading(false)
      })
      return () => { cancelled = true }
    }
    const tableId = selectedCollectionId
    let cancelled = false

    async function loadEntries() {
      setEntriesLoading(true)
      setError(null)
      try {
        const nextEntries = await listCmsDataRows(tableId)
        if (cancelled) return
        setEntries(nextEntries)
        setSelectedEntry((current) => {
          // Auto-select the first entry when none was previously
          // selected (or the previous selection belonged to a
          // different table). We deliberately do NOT force the right
          // sidebar open here — that used to call
          // `setPropertiesPanel({ collapsed: false })`, which fired
          // AFTER the network fetch resolved and animated the sidebar
          // in from 0 → saved width on every page load. The right
          // sidebar's expanded state is now sourced from
          // `propertiesPanel.collapsed` directly by
          // AdminWorkspaceCanvasLayout, so if the user previously closed
          // it, it stays closed; if they had it open, it's already open
          // at the saved width from the first paint.
          if (!current || current.tableId !== tableId) {
            return nextEntries[0] ?? null
          }
          return current
        })
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, 'Could not load entries'))
      } finally {
        if (!cancelled) setEntriesLoading(false)
      }
    }

    void loadEntries()
    return () => { cancelled = true }
  }, [selectedCollectionId])

  // Deep-link effect A: once collections finish loading, resolve ?table= in the
  // original URL and override the default collection selection if a slug match
  // is found. Runs at most once per mount (guarded by deepLinkAppliedRef).
  useEffect(() => {
    if (deepLinkAppliedRef.current) return
    if (loading) return
    deepLinkAppliedRef.current = true

    const tableSlug = initialTableSlugRef.current
    if (!tableSlug) return

    const targetCollection = collections.find((c) => c.slug === tableSlug)
    if (!targetCollection) {
      console.warn('[content] unknown ?table= slug:', tableSlug)
      return
    }

    // Store the row id so effect B can resolve it once the target collection's
    // entries have loaded. null means "no specific row — keep default".
    pendingDeepLinkRef.current = { rowId: initialRowIdRef.current }
    setSelectedCollectionId(targetCollection.id)
    setEntriesLoading(true)
  }, [loading, collections])

  // Deep-link effect B: once entries finish loading for the deep-linked
  // collection, select the requested row (if any). The URL is NOT stripped —
  // the sync below keeps `?table=…&row=…` current so the view stays linkable.
  useEffect(() => {
    const pending = pendingDeepLinkRef.current
    if (!pending || entriesLoading) return

    pendingDeepLinkRef.current = null

    if (pending.rowId !== null) {
      const target = entries.find((e) => e.id === pending.rowId)
      if (target) {
        selectEntry(target)
      } else {
        console.warn('[content] unknown ?row= id:', pending.rowId)
      }
    }
  }, [entries, entriesLoading, selectEntry])

  // Mirror the active collection + entry into the URL so a reload / bookmark /
  // shared link reopens the same selection. Contract matches the inbound
  // deep link: `?table=<collectionSlug>&row=<entryId>`. Gated on `!loading` so
  // the initial selection settles before we write (otherwise the first render
  // would briefly strip an inbound deep link).
  useUrlQuerySync(
    {
      table: selectedCollection?.slug ?? null,
      row: selectedEntry?.id ?? null,
    },
    { enabled: !loading },
  )

  const selectCollection = (tableId: string) => {
    if (tableId === selectedCollectionId) return
    setEntriesLoading(true)
    setSelectedCollectionId(tableId)
  }

  const createUntitledEntry = async () => {
    if (!selectedCollection) return null
    const nextSlug = entries.length === 0 ? 'untitled' : `untitled-${entries.length + 1}`
    const row = await createCmsDataRow(selectedCollection.id, {
      cells: {
        title: 'Untitled',
        slug: nextSlug,
      },
    })
    // Keep "Untitled" stored on the server + visible in the sidebar list, but
    // hand the editor a draft view with an empty title so the title field
    // shows its placeholder instead of pre-filling "Untitled". The user can
    // start typing their real title immediately; on save the draft is
    // persisted with whatever they entered (falling back to "Untitled" on
    // the server side if they leave it blank).
    const draftRow: DataRow = { ...row, cells: { ...row.cells, title: '' } }
    setEntries((current) => updateRowList(current, row))
    selectEntry(draftRow)
    return draftRow
  }

  const duplicateEntry = async (entry: DataRow) => {
    setError(null)
    const collection = collections.find((candidate) => candidate.id === entry.tableId)
    if (!collection) throw new Error('Collection not found')
    const duplicated = await createCmsDataRow(entry.tableId, {
      cells: buildDuplicateRowCells(collection, entry, entries),
    })
    setEntries((current) => updateRowList(current, duplicated))
    selectEntry(duplicated)
    return duplicated
  }

  const createCollection = async (input: CreateDataTableInput) => {
    setError(null)
    setEntriesLoading(true)
    // Always create post-type tables from the Content page.
    const collection = await createCmsDataTable({ ...input, kind: 'postType' })
    setCollections((current) => [...current, collection])
    setEntries([])
    setSelectedCollectionId(collection.id)
    selectEntry(null)
    return collection
  }

  const updateCollection = async (
    tableId: string,
    input: UpdateDataTableInput,
  ) => {
    setError(null)
    const collection = await updateCmsDataTable(tableId, input)
    setCollections((current) => current.map((candidate) =>
      candidate.id === collection.id ? collection : candidate
    ))
    return collection
  }

  const deleteCollection = async (tableId: string) => {
    setError(null)
    await deleteCmsDataTable(tableId)

    const nextCollections = collections.filter((collection) => collection.id !== tableId)
    const nextSelectedCollectionId = selectedCollectionId === tableId
      ? nextCollections[0]?.id ?? null
      : selectedCollectionId
    setCollections(nextCollections)

    if (selectedCollectionId === tableId) {
      setSelectedCollectionId(nextSelectedCollectionId)
      setEntries([])
      setEntriesLoading(Boolean(nextSelectedCollectionId))
      selectEntry(null)
    }
  }

  const renameEntry = async (
    row: DataRow,
    input: { title: string; slug: string },
  ) => {
    setError(null)
    const updatedRow = await saveCmsDataRowDraft(row.id, {
      cells: {
        ...row.cells,
        title: input.title,
        slug: input.slug,
        body: readBodyCell(row.cells),
        featuredMedia: readFeaturedMediaCell(row.cells),
      },
    })
    setEntries((current) => updateRowList(current, updatedRow))
    if (selectedEntry?.id === row.id) selectEntry(updatedRow)
    return updatedRow
  }

  const deleteEntry = async (entry: DataRow) => {
    setError(null)
    await deleteCmsDataRow(entry.id)

    const nextEntries = entries.filter((candidate) => candidate.id !== entry.id)
    const nextSelectedEntry = selectedEntry?.id === entry.id
      ? nextEntries[0] ?? null
      : selectedEntry
    setEntries(nextEntries)

    if (selectedEntry?.id === entry.id) {
      selectEntry(nextSelectedEntry)
    }
    return nextSelectedEntry
  }

  const publishEntry = async (entry: DataRow) => {
    setError(null)
    const updatedRow = await publishCmsDataRow(entry.id)
    setEntries((current) => updateRowList(current, updatedRow))
    if (selectedEntry?.id === entry.id) selectEntry(updatedRow)
    return updatedRow
  }

  const updateEntryStatus = async (
    entry: DataRow,
    // Narrowed to match the `/status` endpoint's accepted statuses —
    // 'scheduled' goes through the dedicated schedule dialog with a
    // target datetime, not this bare setter.
    status: 'draft' | 'unpublished',
  ) => {
    setError(null)
    const updatedRow = await updateCmsDataRowStatus(entry.id, status)
    setEntries((current) => updateRowList(current, updatedRow))
    if (selectedEntry?.id === entry.id) selectEntry(updatedRow)
    return updatedRow
  }

  const updateEntryAuthor = async (
    entry: DataRow,
    authorUserId: string,
  ) => {
    if (entry.authorUserId === authorUserId) return entry
    setError(null)
    const updatedRow = await updateCmsDataRowAuthor(entry.id, authorUserId)
    setEntries((current) => updateRowList(current, updatedRow))
    if (selectedEntry?.id === entry.id) selectEntry(updatedRow)
    return updatedRow
  }

  const moveEntryToCollection = async (
    entry: DataRow,
    tableId: string,
  ) => {
    if (entry.tableId === tableId) return entry
    setError(null)
    const updatedRow = await updateCmsDataRowTable(entry.id, tableId)
    // Active collection view: the moved entry no longer belongs here.
    if (entry.tableId === selectedCollectionId) {
      setEntries((current) => current.filter((candidate) => candidate.id !== entry.id))
    }
    // Active collection view: it may already be the destination if the user
    // is viewing it. In that case the entry should appear in the list.
    if (tableId === selectedCollectionId) {
      setEntries((current) => updateRowList(current, updatedRow))
    }
    if (selectedEntry?.id === entry.id) selectEntry(updatedRow)
    return updatedRow
  }

  const moveSelectedEntryToCollection = async (tableId: string) => {
    if (!selectedEntry || selectedEntry.tableId === tableId) return selectedEntry
    setError(null)
    setEntriesLoading(true)
    const entry = await updateCmsDataRowTable(selectedEntry.id, tableId)
    setSelectedCollectionId(tableId)
    setEntries([entry])
    selectEntry(entry)
    return entry
  }

  return {
    collections,
    entries,
    authors,
    authorsLoading,
    selectedCollection,
    selectedCollectionId,
    selectedEntry,
    contentLoading,
    error,
    setError,
    selectCollection,
    selectEntry,
    updateSelectedEntry,
    createUntitledEntry,
    duplicateEntry,
    createCollection,
    updateCollection,
    deleteCollection,
    renameEntry,
    deleteEntry,
    publishEntry,
    updateEntryStatus,
    updateEntryAuthor,
    moveEntryToCollection,
    moveSelectedEntryToCollection,
  }
}
