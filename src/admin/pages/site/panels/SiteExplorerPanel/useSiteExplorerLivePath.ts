import { useEffect, useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { CMS_PUBLICATION_CHANGED_EVENT } from '@admin/state/adminEvents'
import { getCmsDataRow } from '@core/persistence/cmsData'
import type { Page } from '@core/page-tree'
import { isTemplatePage } from '@core/templates'
import { useEditorStore } from '@site/store/store'

/** A context-menu link must refer to the selected variant's frozen live route. */
export function useSiteExplorerLivePath(page: Page | null): string | null {
  const localeId = useEditorStore((s) => s.site?.localeId)
  const enabled = useEditorStore((s) => s.site?.locales?.find((locale) => locale.id === s.site?.localeId)?.enabled)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1)
    window.addEventListener(CMS_PUBLICATION_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(CMS_PUBLICATION_CHANGED_EVENT, refresh)
  }, [])
  const pageId = page && !isTemplatePage(page) && enabled !== false ? page.id : null
  const { data } = useAsyncResource(
    async () => ({ row: pageId ? await getCmsDataRow(pageId, undefined, undefined, localeId) : null, revision }),
    [pageId, localeId, revision],
  )
  const row = data?.row
  return pageId && data?.revision === revision && row?.id === pageId && row.localeId === localeId &&
    row.localization?.availability === 'online' ? row.publicPath : null
}
