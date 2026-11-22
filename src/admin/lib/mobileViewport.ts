import { useSyncExternalStore } from 'react'

const mobileViewportQuery = '(max-width: 760px)'

export function isMobileViewport(): boolean {
  return globalThis.window?.matchMedia?.(mobileViewportQuery).matches ?? false
}

function subscribe(update: () => void) {
  const media = window.matchMedia?.(mobileViewportQuery)
  media?.addEventListener('change', update)
  return () => media?.removeEventListener('change', update)
}

export function useMobileViewport(): boolean {
  return useSyncExternalStore(subscribe, isMobileViewport)
}
