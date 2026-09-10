import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  publishCmsDataRow,
  saveCmsDataRowDraft,
  updateCmsDataRowStatus,
} from '@core/persistence'
import type { DataRow, DataRowCells, DataRowStatus } from '@core/data/schemas'
import {
  readBodyCell,
  readFeaturedMediaCell,
  readSeoDescriptionCell,
  readSeoTitleCell,
  readSlugCell,
  readTitleCell,
  stripPostTypeBuiltInCells,
} from '@core/data/cells'
import { slugFromTitle } from '@core/utils/slug'
import { getErrorMessage } from '@core/utils/errorMessage'

export type SaveMessage = 'idle' | 'saving' | 'saved' | 'publishing' | 'published' | 'error'

interface UseContentEntryDraftOptions {
  selectedEntry: DataRow | null
  updateSelectedEntry: (entry: DataRow) => void
  setError: (message: string | null) => void
}

/**
 * Local draft state for the currently selected content entry.
 *
 * Body is a plain markdown string — the editor (Tiptap) owns the rich
 * document in memory and projects its markdown form back into this hook
 * on every keystroke via the `setBody` setter. There's no intermediate
 * block-model shape; the editor's `onUpdate` already serialises to
 * markdown.
 */
export function useContentEntryDraft({
  selectedEntry,
  updateSelectedEntry,
  setError,
}: UseContentEntryDraftOptions) {
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [seoTitle, setSeoTitle] = useState('')
  const [seoDescription, setSeoDescription] = useState('')
  const [featuredMediaId, setFeaturedMediaId] = useState<string | null>(null)
  const [body, setBody] = useState('')
  // Values of the collection's CUSTOM (non-built-in) fields, keyed by field
  // id — edited generically in the Content settings panel and saved through
  // the same draft lifecycle as the built-ins above.
  const [customCells, setCustomCells] = useState<DataRowCells>({})
  const [saveMessage, setSaveMessage] = useState<SaveMessage>('idle')
  const latestDraft = useRef({ selectedEntry, title, slug, seoTitle, seoDescription, featuredMediaId, body, customCells })
  useLayoutEffect(() => {
    latestDraft.current = { selectedEntry, title, slug, seoTitle, seoDescription, featuredMediaId, body, customCells }
  }, [selectedEntry, title, slug, seoTitle, seoDescription, featuredMediaId, body, customCells])

  const isCurrentSelection = () => latestDraft.current.selectedEntry?.id === selectedEntry?.id &&
    latestDraft.current.selectedEntry?.localeId === selectedEntry?.localeId
  const hasUnchangedFields = () => {
    const current = latestDraft.current
    return current.title === title && current.slug === slug && current.seoTitle === seoTitle &&
      current.seoDescription === seoDescription && current.featuredMediaId === featuredMediaId &&
      current.body === body && current.customCells === customCells
  }


  // Exception #1: referenced in the useLayoutEffect dep array below, so it
  // needs a stable identity that react-hooks/exhaustive-deps can see.
  const applySelectedEntry = useCallback((entry: DataRow | null) => {
    setTitle(entry ? readTitleCell(entry.cells) : '')
    setSlug(entry ? readSlugCell(entry.cells) : '')
    setSeoTitle(entry ? readSeoTitleCell(entry.cells) : '')
    setSeoDescription(entry ? readSeoDescriptionCell(entry.cells) : '')
    setFeaturedMediaId(entry ? readFeaturedMediaCell(entry.cells) : null)
    setBody(entry ? readBodyCell(entry.cells) : '')
    setCustomCells(entry ? stripPostTypeBuiltInCells(entry.cells) : {})
    setSaveMessage('idle')
  }, [])

  const setCustomCell = (fieldId: string, value: unknown) => {
    setCustomCells((cells) => ({ ...cells, [fieldId]: value }))
  }

  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useLayoutEffect(() => {
    applySelectedEntry(selectedEntry)
  }, [applySelectedEntry, selectedEntry?.id, selectedEntry?.localeId])
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const applyEntryFields = (entry: DataRow) => {
    setTitle(readTitleCell(entry.cells))
    setSlug(readSlugCell(entry.cells))
    setSeoTitle(readSeoTitleCell(entry.cells))
    setSeoDescription(readSeoDescriptionCell(entry.cells))
    setFeaturedMediaId(readFeaturedMediaCell(entry.cells))
    setCustomCells(stripPostTypeBuiltInCells(entry.cells))
  }

  const isDirty = (() => {
    if (!selectedEntry) return false
    return title !== readTitleCell(selectedEntry.cells) ||
      slug !== readSlugCell(selectedEntry.cells) ||
      seoTitle !== readSeoTitleCell(selectedEntry.cells) ||
      seoDescription !== readSeoDescriptionCell(selectedEntry.cells) ||
      featuredMediaId !== readFeaturedMediaCell(selectedEntry.cells) ||
      body !== readBodyCell(selectedEntry.cells) ||
      // Cell values are JSON by definition (persisted via cells_json), so a
      // stringify comparison is exact — same approach as useDataRowDraft.
      JSON.stringify(customCells) !== JSON.stringify(stripPostTypeBuiltInCells(selectedEntry.cells))
  })()

  const saveDraft = async (): Promise<DataRow | null> => {
    if (!selectedEntry) return null
    const nextTitle = title.trim() || 'Untitled'
    const nextSlug = slugFromTitle(slug || nextTitle)
    const row = await saveCmsDataRowDraft(selectedEntry.id, {
      localeId: selectedEntry.localeId,
      cells: {
        ...selectedEntry.cells,
        ...customCells,
        title: nextTitle,
        slug: nextSlug,
        body,
        featuredMedia: featuredMediaId,
        seoTitle: seoTitle.trim(),
        seoDescription: seoDescription.trim(),
      },
    })
    if (isCurrentSelection()) {
      updateSelectedEntry(row)
      if (hasUnchangedFields()) applyEntryFields(row)
    }
    return row
  }

  const handleSaveDraft = async () => {
    setSaveMessage('saving')
    setError(null)
    try {
      await saveDraft()
      if (isCurrentSelection()) setSaveMessage(hasUnchangedFields() ? 'saved' : 'idle')
    } catch (err) {
      if (!isCurrentSelection()) return
      setSaveMessage('error')
      setError(getErrorMessage(err, 'Could not save draft'))
    }
  }

  const handlePublish = async () => {
    if (!selectedEntry) return
    setSaveMessage('publishing')
    setError(null)
    try {
      const savedRow = await saveDraft()
      if (!savedRow) return
      const publishedRow = await publishCmsDataRow(savedRow.id, undefined, undefined, savedRow.localeId)
      if (!isCurrentSelection()) return
      updateSelectedEntry(publishedRow)
      setSaveMessage('published')
    } catch (err) {
      if (!isCurrentSelection()) return
      setSaveMessage('error')
      setError(getErrorMessage(err, 'Could not publish entry'))
    }
  }

  const handleStatusChange = async (nextStatus: DataRowStatus) => {
    if (!selectedEntry || nextStatus === selectedEntry.status) return

    if (nextStatus === 'published') {
      await handlePublish()
      return
    }
    if (nextStatus === 'scheduled') {
      // Scheduling requires a target datetime — the Content workspace
      // surfaces it via the `SchedulePublishDialog`, not through this
      // bare status setter. Reject defensively so a future caller can't
      // slip 'scheduled' through with no time set.
      setError('Use the schedule dialog to set a publish time')
      return
    }

    setSaveMessage('saving')
    setError(null)
    try {
      const savedRow = await saveDraft()
      if (!savedRow) return
      const updatedRow = await updateCmsDataRowStatus(savedRow.id, nextStatus, undefined, undefined, savedRow.localeId)
      if (!isCurrentSelection()) return
      updateSelectedEntry(updatedRow)
      if (hasUnchangedFields()) applyEntryFields(updatedRow)
      setSaveMessage('idle')
    } catch (err) {
      if (!isCurrentSelection()) return
      setSaveMessage('error')
      setError(getErrorMessage(err, 'Could not update entry status'))
    }
  }

  return {
    title,
    slug,
    seoTitle,
    seoDescription,
    featuredMediaId,
    body,
    customCells,
    isDirty,
    saveMessage,
    setTitle,
    setSlug,
    setSeoTitle,
    setSeoDescription,
    setFeaturedMediaId,
    setBody,
    setCustomCell,
    setSaveMessage,
    saveDraft,
    handleSaveDraft,
    handlePublish,
    handleStatusChange,
    applySelectedEntry,
  }
}
