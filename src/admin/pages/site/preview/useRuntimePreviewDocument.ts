import { useEffect, useState } from 'react'
import type { Page, SiteDocument } from '@core/page-tree'
import { isAbortError } from '@core/http'
import { buildCmsRuntimePreview } from '@core/persistence'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { useAsyncResource } from '@admin/lib/useAsyncResource'

/**
 * How long the draft must stay unchanged before the preview rebuilds. Every
 * build uploads the whole site document and re-bundles and renders the page on
 * the server; without this, each keystroke or remote collab update aborted the
 * in-flight build and started another (bursts of cancelled requests).
 */
export const PREVIEW_SITE_SETTLE_MS = 400

interface LoadedPreviewDocument {
  pageId: string
  contextKey: string
  html: string
}

interface RuntimePreviewDocumentState {
  /**
   * The newest built document for this page and context. While a rebuild for
   * a newer draft is in flight it stays the previous build (`loading` is true)
   * rather than blanking the preview.
   */
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
  const settledSite = useSettledSite(site)
  const { data, loading, error, refresh } = useAsyncResource<LoadedPreviewDocument>(
    async (signal) => {
      try {
        const preview = await buildCmsRuntimePreview(
          {
            site: settledSite,
            pageId: page.id,
            templateContext: templatePreviewContext,
          },
          { signal },
        )
        return {
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
    [settledSite, page.id, contextKey],
    { fallbackError: 'Preview build failed' },
  )

  const html = data?.pageId === page.id && data.contextKey === contextKey ? data.html : null

  return { html, loading, error, refresh }
}

/** `site`, updated only once it has stayed unchanged for PREVIEW_SITE_SETTLE_MS. */
function useSettledSite(site: SiteDocument): SiteDocument {
  const [settled, setSettled] = useState(site)
  useEffect(() => {
    if (settled === site) return undefined
    const timer = setTimeout(() => setSettled(site), PREVIEW_SITE_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [site, settled])
  return settled
}
