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
  readSeoDescriptionCell,
  readSeoTitleCell,
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
  // Every data table (all kinds) — relation custom fields can target any
  // table, so the settings panel needs the full list to resolve targets.
  const [tables, setTables] = useState<DataTable[]>([])
  const [collections, setCollections] = useState<DataTable[]>([])
  const [entries, setEntries] = useState<DataRow[]>([])
  const [authors, setAuthors] = useState<DataUserReference[]>([])
  const [authorsLoading, setAuthorsLoading] = useState(true)
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null)
  const [selectedEntry, setSelectedEntry] = useState<DataRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [entriesLoading, setEntriesLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Mirrors the collection state synchronously so two imperative bridge calls
  // in one React turn never make routing decisions from the previous render.
  const selectedCollectionIdRef = useRef<string | null>(null)
  // The list request and imperative bridge both need the newest active row,
  // including updates that React has not committed to a new render yet.
  const selectedEntryRef = useRef<DataRow | null>(null)

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
  // Synchronously invalidates an older collection load before React has
  // rendered the newly selected collection and run the old effect's cleanup.
  const entriesLoadEpochRef = useRef(0)

  const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) ?? null
  const contentLoading = loading || entriesLoading

  // Exception #1: referenced in deep-link effect B's dependency array, so it
  // needs a stable identity for react-hooks/exhaustive-deps.
  const selectEntry = useCallback((entry: DataRow | null) => {
    selectedEntryRef.current = entry
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
    selectedEntryRef.current = entry
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
        setTables(allTables)
        setCollections(nextCollections)
        setEntriesLoading(Boolean(fallbackCollectionId))
        entriesLoadEpochRef.current += 1
        setSelectedCollectionId((current) => {
          const next = current ?? fallbackCollectionId
          selectedCollectionIdRef.current = next
          return next
        })
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
    const loadEpoch = ++entriesLoadEpochRef.current
    if (!selectedCollectionId) {
      let cancelled = false
      queueMicrotask(() => {
        if (!cancelled && loadEpoch === entriesLoadEpochRef.current) {
          setEntriesLoading(false)
        }
      })
      return () => { cancelled = true }
    }
    const tableId = selectedCollectionId
    const selectedAtLoadStart = selectedEntryRef.current
    let cancelled = false

    async function loadEntries() {
      setEntriesLoading(true)
      setError(null)
      try {
        const nextEntries = await listCmsDataRows(tableId)
        if (cancelled || loadEpoch !== entriesLoadEpochRef.current) return
        // A row changed after this request began (for example by an MCP save)
        // wins over the older list snapshot. Otherwise the response is
        // authoritative, including when it omits a concurrently deleted row.
        const current = selectedEntryRef.current
        const currentIsInTable = current?.tableId === tableId
        const currentChangedDuringLoad = currentIsInTable && current !== selectedAtLoadStart
        const serverSelected = currentIsInTable
          ? nextEntries.find((entry) => entry.id === current.id) ?? null
          : null
        const nextSelected = currentChangedDuringLoad
          ? current
          : serverSelected ?? nextEntries[0] ?? null
        selectedEntryRef.current = nextSelected
        setEntries(currentChangedDuringLoad && nextSelected
          ? updateRowList(nextEntries, nextSelected)
          : nextEntries)
        setSelectedEntry(nextSelected)
      } catch (err) {
        if (!cancelled && loadEpoch === entriesLoadEpochRef.current) {
          setError(getErrorMessage(err, 'Could not load entries'))
        }
      } finally {
        if (!cancelled && loadEpoch === entriesLoadEpochRef.current) {
          setEntriesLoading(false)
        }
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
    if (targetCollection.id !== selectedCollectionIdRef.current) {
      entriesLoadEpochRef.current += 1
      selectedCollectionIdRef.current = targetCollection.id
      setSelectedCollectionId(targetCollection.id)
      setEntriesLoading(true)
    }
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
    if (tableId === selectedCollectionIdRef.current) return
    entriesLoadEpochRef.current += 1
    setEntriesLoading(true)
    selectedCollectionIdRef.current = tableId
    setSelectedCollectionId(tableId)
  }

  const openEntry = (entry: DataRow): boolean => {
    if (!collections.some((collection) => collection.id === entry.tableId)) return false

    if (entry.tableId !== selectedCollectionIdRef.current) {
      // Invalidate the previous collection's in-flight list immediately. The
      // new collection effect will load its complete list after this render;
      // seeding the requested row keeps the editor and URL coherent meanwhile.
      entriesLoadEpochRef.current += 1
      setEntriesLoading(true)
      selectedCollectionIdRef.current = entry.tableId
      setSelectedCollectionId(entry.tableId)
      setEntries([entry])
    } else {
      setEntries((current) => current.every((candidate) => candidate.tableId === entry.tableId)
        ? updateRowList(current, entry)
        : [entry])
    }

    selectEntry(entry)
    return true
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
    setTables((current) => [...current, collection])
    setCollections((current) => [...current, collection])
    setEntries([])
    entriesLoadEpochRef.current += 1
    selectedCollectionIdRef.current = collection.id
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
    setTables((current) => current.map((candidate) =>
      candidate.id === collection.id ? collection : candidate
    ))
    setCollections((current) => current.map((candidate) =>
      candidate.id === collection.id ? collection : candidate
    ))
    return collection
  }

  const deleteCollection = async (tableId: string) => {
    setError(null)
    await deleteCmsDataTable(tableId)

    setTables((current) => current.filter((table) => table.id !== tableId))
    const nextCollections = collections.filter((collection) => collection.id !== tableId)
    const nextSelectedCollectionId = selectedCollectionId === tableId
      ? nextCollections[0]?.id ?? null
      : selectedCollectionId
    setCollections(nextCollections)

    if (selectedCollectionId === tableId) {
      entriesLoadEpochRef.current += 1
      selectedCollectionIdRef.current = nextSelectedCollectionId
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
        seoTitle: readSeoTitleCell(row.cells),
        seoDescription: readSeoDescriptionCell(row.cells),
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
    entriesLoadEpochRef.current += 1
    selectedCollectionIdRef.current = tableId
    setSelectedCollectionId(tableId)
    setEntries([entry])
    selectEntry(entry)
    return entry
  }

  return {
    tables,
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
    openEntry,
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
