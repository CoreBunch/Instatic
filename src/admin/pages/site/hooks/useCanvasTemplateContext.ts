import type { Page } from '@core/page-tree'
import { useCmsMediaAssetLookup } from '@admin/pages/media/hooks/useCmsMediaAssetByPath'
import { useTemplatePreviewContext } from './useTemplatePreviewContext'

/**
 * The template contexts the canvas renders with.
 *
 * `previewContext` is the serializable context from `useTemplatePreviewContext`
 * — it also travels to the runtime-preview endpoint (hover preview, preview
 * overlay, script build), where the server substitutes its own prefetch map.
 *
 * `canvasContext` is that context plus the client-side media lookup (keyed by
 * asset id and by path), so `format: 'media'` bindings resolve bare asset
 * references on the canvas exactly like the publisher does. The lookup is
 * attached here rather than inside `useTemplatePreviewContext` so it never
 * leaks into what gets serialized.
 */
export function useCanvasTemplateContext(page: Page | null) {
  const { context: previewContext, loading } = useTemplatePreviewContext(page)
  const media = useCmsMediaAssetLookup()
  const canvasContext = previewContext ? { ...previewContext, media } : undefined
  return { previewContext, canvasContext, loading }
}
