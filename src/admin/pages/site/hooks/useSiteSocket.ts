/**
 * useSiteSocket — lifecycle glue for the live-pull channel (multi-admin
 * level B). The actual transport + merge machinery lives in
 * `siteSocketClient.ts` / `siteSyncMerge.ts` and is LAZY-imported here so
 * its chunk (event schemas, snapshot fetching, conflict plumbing) stays out
 * of the site route's first-paint bundle.
 *
 * `enabled` gates on the site document being loaded — before that there is
 * no sync cursor to subscribe with and nothing to merge into.
 */
import { useEffect } from 'react'

export function useSiteSocket(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined
    if (typeof WebSocket === 'undefined') return undefined

    let dispose: (() => void) | null = null
    let cancelled = false

    void import('./siteSocketClient')
      .then((mod) => {
        if (cancelled) return
        dispose = mod.connectSiteSocket()
      })
      .catch((err) => {
        console.error('[useSiteSocket] failed to load the sync client:', err)
      })

    return () => {
      cancelled = true
      dispose?.()
    }
  }, [enabled])
}
