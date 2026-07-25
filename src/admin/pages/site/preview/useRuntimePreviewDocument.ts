import type { Page, SiteDocument } from '@core/page-tree'
import { isAbortError } from '@core/http'
import { buildCmsRuntimePreview } from '@core/persistence'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { useAsyncResource } from '@admin/lib/useAsyncResource'

interface LoadedPreviewDocument {
  site: SiteDocument
  pageId: string
  contextKey: string
  html: string
}

interface RuntimePreviewDocumentState {
  html: string | null
  loading: boolean
  error: string | null
  refresh: () => void
}

/**
 * Build a server-resolved preview document for an in-memory draft page.
 *
 * Full-page Preview and lightweight explorer hover previews share this hook so
 * both render through the same authenticated runtime boundary, including
 * template data, loops, media, and unsaved site changes.
 */
export function useRuntimePreviewDocument(
  site: SiteDocument,
  page: Page,
  templatePreviewContext: TemplateRenderDataContext | undefined,
): RuntimePreviewDocumentState {
  const contextKey = JSON.stringify(templatePreviewContext ?? null)
  const { data, loading, error, refresh } = useAsyncResource<LoadedPreviewDocument>(
    async (signal) => {
      try {
        const preview = await buildCmsRuntimePreview(
          {
            site,
            pageId: page.id,
            templateContext: templatePreviewContext,
          },
          { signal },
        )
        return {
          site,
          pageId: page.id,
          contextKey,
          html: preview.html,
        }
      } catch (err) {
        if (!signal.aborted && !isAbortError(err)) {
          console.error('[RuntimePreview] Failed to build preview:', err)
        }
        throw err
      }
    },
    [site, page.id, contextKey],
    { fallbackError: 'Preview build failed' },
  )

  const html =
    data?.site === site && data.pageId === page.id && data.contextKey === contextKey
      ? data.html
      : null

  return { html, loading, error, refresh }
}
