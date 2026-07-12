/**
 * Site-plugin summaries for the Plugins page — the union of draft folders
 * and site-local runtime rows with computed states. Used to merge
 * draft-only plugins (no runtime row yet) into the single plugin list and
 * to feed the scaffold dialog's taken-id check.
 */
import { useCallback, useEffect, useState } from 'react'
import { apiRequest } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  SitePluginsPayloadSchema,
  type SitePluginSummary,
} from '@core/site-plugins'
import { pushToast } from '@ui/components/Toast'

export interface UseSitePluginsResult {
  /** Null while the first load is in flight. */
  sitePlugins: SitePluginSummary[] | null
  reload: () => Promise<void>
}

export function useSitePlugins(): UseSitePluginsResult {
  const [sitePlugins, setSitePlugins] = useState<SitePluginSummary[] | null>(null)

  // useCallback kept: stable identity for the load-on-mount effect's dep array.
  const reload = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiRequest('/admin/api/cms/site-plugins', {
        schema: SitePluginsPayloadSchema,
      })
      setSitePlugins(payload.sitePlugins)
    } catch (err) {
      console.error('[useSitePlugins] load failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not load site plugins',
        body: getErrorMessage(err, 'Unknown error'),
      })
      setSitePlugins([])
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      void reload()
    }, 0)
    return () => clearTimeout(timer)
  }, [reload])

  return { sitePlugins, reload }
}
