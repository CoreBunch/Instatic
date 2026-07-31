import { useCallback, useLayoutEffect, useState } from 'react'
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
  }, [applySelectedEntry, selectedEntry?.id])
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
    updateSelectedEntry(row)
    applyEntryFields(row)
    return row
  }

  const handleSaveDraft = async () => {
    setSaveMessage('saving')
    setError(null)
    try {
      await saveDraft()
      setSaveMessage('saved')
    } catch (err) {
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
      const publishedRow = await publishCmsDataRow(savedRow.id)
      updateSelectedEntry({
        ...savedRow,
        status: publishedRow.status,
        updatedAt: publishedRow.updatedAt,
        publishedAt: publishedRow.publishedAt,
        deletedAt: publishedRow.deletedAt,
      })
      setSaveMessage('published')
    } catch (err) {
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
      const updatedRow = await updateCmsDataRowStatus(savedRow.id, nextStatus)
      updateSelectedEntry(updatedRow)
      applyEntryFields(updatedRow)
      setSaveMessage('idle')
    } catch (err) {
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
    handleSaveDraft,
    handlePublish,
    handleStatusChange,
    applySelectedEntry,
  }
}
