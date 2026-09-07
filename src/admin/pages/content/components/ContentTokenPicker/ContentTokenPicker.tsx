import type { RefObject } from 'react'
import type { DataRow } from '@core/data/schemas'
import { DataBindingPicker } from '@admin/shared/DataBindingPicker'
import { bindingToToken } from '@core/templates/tokenInterpolation'
import type { useContentEntryDraft } from '../../hooks/useContentEntryDraft'

export function ContentTokenPicker({ localeId, tableId, entry, draft, triggerRef, onClose, onInsert }: {
  localeId?: string; tableId: string; entry: DataRow | null
  draft: ReturnType<typeof useContentEntryDraft>; triggerRef: RefObject<HTMLButtonElement | null>
  onClose: () => void; onInsert: (text: string) => void
}) {
  return (
        <DataBindingPicker
          localeId={localeId}
          label="Post body"
          control={{ type: 'text', label: 'Post body' }}
          insertMode
          fieldSelectionMode="token"
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          scopedTableId={tableId}
          scopeLabel="Current entry"
          previewFields={{
            ...entry?.cells,
            ...draft.customCells,
            title: draft.title,
            slug: draft.slug,
            body: draft.body,
            featuredMedia: draft.featuredMediaId,
            seoTitle: draft.seoTitle,
            seoDescription: draft.seoDescription,
          }}
          onClose={onClose}
          onPick={(binding) => {
            onInsert(bindingToToken(binding.source, binding.field))
          }}
        />
  )
}
