import type { EditorStoreSliceCreator } from '@site/store/types'

interface PreviewSelectionSlice {
  /** Session-only source page or entry for a template; unset uses the first source. */
  templatePreviewSelection: Record<string, string>
  setTemplatePreviewSelection: (templateId: string, sourceId: string | null) => void
  /** Example entry for editing a component outside its enclosing loop. */
  componentPreviewSelection: Record<string, { tableSlug: string; rowId: string | null }>
  setComponentPreviewSelection: (componentId: string, selection: { tableSlug: string; rowId: string | null } | null) => void
}

declare module '@site/store/types' {
  interface EditorStore extends PreviewSelectionSlice {}
}

export const createPreviewSelectionSlice: EditorStoreSliceCreator<PreviewSelectionSlice> = (set) => ({
  templatePreviewSelection: {},
  componentPreviewSelection: {},
  setTemplatePreviewSelection: (templateId, sourceId) =>
    set((state) => {
      if (sourceId === null) delete state.templatePreviewSelection[templateId]
      else state.templatePreviewSelection[templateId] = sourceId
    }),
  setComponentPreviewSelection: (componentId, selection) =>
    set((state) => {
      if (selection === null) delete state.componentPreviewSelection[componentId]
      else state.componentPreviewSelection[componentId] = selection
    }),
})
