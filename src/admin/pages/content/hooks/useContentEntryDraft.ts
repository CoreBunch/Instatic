import { useCallback, useLayoutEffect, useState } from 'react'
import {
  publishCmsDataRow,
  saveCmsDataRowDraft,
  updateCmsDataRowStatus,
} from '@core/persistence'
import type { DataRow, DataRowStatus } from '@core/data/schemas'
import {
  readBodyCell,
  readFeaturedMediaCell,
  readSeoCell,
  readSlugCell,
  readTitleCell,
} from '@core/data/cells'
import { slugFromTitle } from '@core/utils/slug'
import type { SeoMetadata } from '@core/seo'
import { getErrorMessage } from '@core/utils/errorMessage'

export type SaveMessage = 'idle' | 'saving' | 'saved' | 'publishing' | 'published' | 'error'

/**
 * Merge the content panel's SEO title/description draft strings into the
 * row's existing structured `seo` cell. The SEO workspace owns the other
 * fields (OG/X/canonical/noindex) — they must survive a content-panel save
 * untouched. Empty draft strings remove the corresponding key.
 */
export function draftSeoCell(
  cells: DataRow['cells'],
  seoTitle: string,
  seoDescription: string,
): SeoMetadata {
  const existing = readSeoCell(cells) ?? {}
  const next: SeoMetadata = { ...existing }
  const title = seoTitle.trim()
  const description = seoDescription.trim()
  if (title === '') delete next.title
  else next.title = title
  if (description === '') delete next.description
  else next.description = description
  return next
}

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
  const [saveMessage, setSaveMessage] = useState<SaveMessage>('idle')

  // Exception #1: referenced in the useLayoutEffect dep array below, so it
  // needs a stable identity that react-hooks/exhaustive-deps can see.
  const applySelectedEntry = useCallback((entry: DataRow | null) => {
    setTitle(entry ? readTitleCell(entry.cells) : '')
    setSlug(entry ? readSlugCell(entry.cells) : '')
    setSeoTitle(entry ? (readSeoCell(entry.cells)?.title ?? '') : '')
    setSeoDescription(entry ? (readSeoCell(entry.cells)?.description ?? '') : '')
    setFeaturedMediaId(entry ? readFeaturedMediaCell(entry.cells) : null)
    setBody(entry ? readBodyCell(entry.cells) : '')
    setSaveMessage('idle')
  }, [])

  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useLayoutEffect(() => {
    applySelectedEntry(selectedEntry)
  }, [applySelectedEntry, selectedEntry?.id])
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const applyEntryFields = (entry: DataRow) => {
    setTitle(readTitleCell(entry.cells))
    setSlug(readSlugCell(entry.cells))
    setSeoTitle(readSeoCell(entry.cells)?.title ?? '')
    setSeoDescription(readSeoCell(entry.cells)?.description ?? '')
    setFeaturedMediaId(readFeaturedMediaCell(entry.cells))
  }

  const isDirty = (() => {
    if (!selectedEntry) return false
    return title !== readTitleCell(selectedEntry.cells) ||
      slug !== readSlugCell(selectedEntry.cells) ||
      seoTitle !== (readSeoCell(selectedEntry.cells)?.title ?? '') ||
      seoDescription !== (readSeoCell(selectedEntry.cells)?.description ?? '') ||
      featuredMediaId !== readFeaturedMediaCell(selectedEntry.cells) ||
      body !== readBodyCell(selectedEntry.cells)
  })()

  const saveDraft = async (): Promise<DataRow | null> => {
    if (!selectedEntry) return null
    const nextTitle = title.trim() || 'Untitled'
    const nextSlug = slugFromTitle(slug || nextTitle)
    const row = await saveCmsDataRowDraft(selectedEntry.id, {
      cells: {
        ...selectedEntry.cells,
        title: nextTitle,
        slug: nextSlug,
        body,
        featuredMedia: featuredMediaId,
        seo: draftSeoCell(selectedEntry.cells, seoTitle, seoDescription),
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
    isDirty,
    saveMessage,
    setTitle,
    setSlug,
    setSeoTitle,
    setSeoDescription,
    setFeaturedMediaId,
    setBody,
    setSaveMessage,
    handleSaveDraft,
    handlePublish,
    handleStatusChange,
    applySelectedEntry,
  }
}
