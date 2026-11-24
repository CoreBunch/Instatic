import type { Page } from '@core/page-tree'
import { useCmsMediaAssetLookup } from '@admin/pages/media/hooks/useCmsMediaAssetByPath'
import { useAppPairPreview } from '../canvas/useAppPairPreview'
import { useTemplatePreviewContext } from './useTemplatePreviewContext'

/**
 * The template contexts the canvas renders with.
 *
 * `templatePreviewContext` is the serializable context from
 * `useTemplatePreviewContext`, with the app-pairing preview state layered on
 * when the page has a pairing form (`useAppPairPreview`, which also returns
 * that form's `stateControl`). It travels to the runtime-preview endpoint
 * (hover preview, preview overlay, script build), where the server substitutes
 * its own prefetch map.
 *
 * `canvasTemplateContext` is that context plus the client-side media lookup
 * (keyed by asset id and by path), so `format: 'media'` bindings resolve bare
 * asset references on the canvas exactly like the publisher does. The lookup
 * is attached here rather than inside `useTemplatePreviewContext` so it never
 * leaks into what gets serialized.
 */
export function useCanvasTemplateContext(page: Page | null) {
  const { context: pagePreviewContext, loading } = useTemplatePreviewContext(page)
  const { templatePreviewContext, stateControl } = useAppPairPreview(page, pagePreviewContext)
  const media = useCmsMediaAssetLookup()
  const canvasTemplateContext = templatePreviewContext ? { ...templatePreviewContext, media } : undefined
  return { templatePreviewContext, canvasTemplateContext, stateControl, loading }
}
