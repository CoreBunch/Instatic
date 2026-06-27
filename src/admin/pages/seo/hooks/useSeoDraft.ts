/**
 * useSeoDraft — local draft state for one target's SeoMetadata object.
 *
 * Field edits stay local until Save; empty strings mean "unset" (the field
 * falls back through the resolver chain), so the persisted object only
 * carries explicit overrides. `isDirty` compares the normalized draft to
 * the stored value; the editor reports it to the workspace save bridge for
 * the toolbar controls and the target-switch guard.
 */
import { useState } from 'react'
import type { SeoMetadata } from '@core/seo'

export type SeoSaveState = 'idle' | 'saving' | 'saved' | 'publishing' | 'published' | 'error'

/** String-valued SeoMetadata keys editable through the snippet inputs. */
export type SeoDraftField =
  | 'title'
  | 'description'
  | 'canonicalUrl'
  | 'ogTitle'
  | 'ogDescription'
  | 'ogImage'
  | 'ogImageAlt'
  | 'xTitle'
  | 'xDescription'
  | 'xImage'
  | 'xImageAlt'

const STRING_FIELDS: readonly SeoDraftField[] = [
  'title',
  'description',
  'canonicalUrl',
  'ogTitle',
  'ogDescription',
  'ogImage',
  'ogImageAlt',
  'xTitle',
  'xDescription',
  'xImage',
  'xImageAlt',
]

/** Drop empty-string keys so the stored object only has explicit values. */
export function normalizeSeoDraft(draft: SeoMetadata): SeoMetadata {
  const next: SeoMetadata = {}
  for (const key of STRING_FIELDS) {
    const value = draft[key]
    if (typeof value === 'string' && value.trim() !== '') next[key] = value.trim()
  }
  if (draft.noindex === true) next.noindex = true
  if (draft.ogType !== undefined) next.ogType = draft.ogType
  if (draft.xCard !== undefined) next.xCard = draft.xCard
  return next
}

function sameSeo(a: SeoMetadata, b: SeoMetadata): boolean {
  return JSON.stringify(normalizeSeoDraft(a)) === JSON.stringify(normalizeSeoDraft(b))
}

export interface UseSeoDraftResult {
  draft: SeoMetadata
  isDirty: boolean
  saveState: SeoSaveState
  saveError: string | null
  setField: (field: SeoDraftField, value: string) => void
  setOgType: (value: SeoMetadata['ogType']) => void
  setXCard: (value: SeoMetadata['xCard']) => void
  setNoindex: (value: boolean) => void
  markSaving: () => void
  markSaved: (saved: SeoMetadata) => void
  markPublishing: () => void
  markPublished: () => void
  markError: (message: string) => void
}

export function useSeoDraft(stored: SeoMetadata | null): UseSeoDraftResult {
  const [draft, setDraft] = useState<SeoMetadata>(stored ?? {})
  const [baseline, setBaseline] = useState<SeoMetadata>(stored ?? {})
  const [saveState, setSaveState] = useState<SeoSaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)

  const isDirty = !sameSeo(draft, baseline)

  function update(mutate: (next: SeoMetadata) => void): void {
    setDraft((current) => {
      const next = { ...current }
      mutate(next)
      return next
    })
    if (saveState !== 'idle') setSaveState('idle')
    if (saveError) setSaveError(null)
  }

  return {
    draft,
    isDirty,
    saveState,
    saveError,
    setField: (field, value) =>
      update((next) => {
        if (value === '') delete next[field]
        else next[field] = value
      }),
    setOgType: (value) =>
      update((next) => {
        if (value === undefined) delete next.ogType
        else next.ogType = value
      }),
    setXCard: (value) =>
      update((next) => {
        if (value === undefined) delete next.xCard
        else next.xCard = value
      }),
    setNoindex: (value) =>
      update((next) => {
        if (value) next.noindex = true
        else delete next.noindex
      }),
    markSaving: () => {
      setSaveState('saving')
      setSaveError(null)
    },
    markSaved: (saved) => {
      setBaseline(saved)
      setDraft(saved)
      setSaveState('saved')
    },
    markPublishing: () => {
      setSaveState('publishing')
      setSaveError(null)
    },
    markPublished: () => {
      setSaveState('published')
    },
    markError: (message) => {
      setSaveState('error')
      setSaveError(message)
    },
  }
}
