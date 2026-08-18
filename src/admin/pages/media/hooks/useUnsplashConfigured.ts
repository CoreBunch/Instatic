/**
 * Whether this installation has an Unsplash access key.
 *
 * Asked once per admin session and cached module-wide: the answer comes from
 * an environment variable, so it cannot change while the tab is open, and
 * every surface that offers the feature (Media toolbar, viewer menu) would
 * otherwise ask the same question on every mount.
 *
 * Returns `false` until the answer arrives, which is the right default — a
 * button that appears a beat late is better than one that appears and then
 * vanishes, and an install without a key never renders it at all.
 */
import { useEffect, useState } from 'react'
import { getCmsUnsplashStatus } from '@core/persistence/cmsMedia'

let cached: boolean | null = null
let inFlight: Promise<boolean> | null = null

function load(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached)
  // Share one request across every component that mounts before it settles.
  inFlight ??= getCmsUnsplashStatus()
    .then((configured) => {
      cached = configured
      return configured
    })
    .catch((err) => {
      // A failed probe means "do not offer the feature". Logged rather than
      // toasted: the user did not ask for this, and a toast on page load for
      // a feature they may not use is noise.
      console.error('[useUnsplashConfigured] status check failed:', err)
      cached = false
      return false
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

export function useUnsplashConfigured(): boolean {
  const [configured, setConfigured] = useState(cached ?? false)

  useEffect(() => {
    if (cached !== null) return
    let active = true
    void load().then((value) => {
      if (active) setConfigured(value)
    })
    return () => { active = false }
  }, [])

  return configured
}
