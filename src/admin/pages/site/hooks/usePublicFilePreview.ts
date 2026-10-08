import type { SiteFile } from '@core/files/schemas'
import type { PublicFileReferences } from '@core/files/references'
import { buildCmsPublicFilePreview } from '@core/persistence'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useEffect } from 'react'
import { pushToast } from '@ui/components/Toast'

const EMPTY_FILES: PublicFileReferences = {}

/** Binary previews refresh on file edits, independently of the canvas script toggle. */
export function usePublicFilePreview(files: readonly SiteFile[]) {
  const assets = files.filter((file) => file.type === 'asset' && file.blob)
  const signature = JSON.stringify(assets)
  const { data, loading, error, refresh } = useAsyncResource(
    async (signal) => ({
      signature,
      references: assets.length > 0 ? await buildCmsPublicFilePreview(assets, { signal }) : EMPTY_FILES,
    }),
    [signature],
    { fallbackError: 'Public file preview failed' },
  )
  useEffect(() => {
    if (error) pushToast({ kind: 'error', title: 'File preview failed', body: error })
  }, [error])
  useEffect(() => {
    if (assets.length === 0) return
    const timer = window.setInterval(refresh, 10 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [assets.length, refresh])
  const current = data?.signature === signature ? data : null
  return {
    files: current?.references ?? EMPTY_FILES,
    loading: assets.length > 0 && (loading || !current) && !error,
    error,
    refresh,
  }
}
