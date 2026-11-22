import { lazy } from 'react'

/** One on-demand settings bundle shared by all admin layouts. */
export const LazySettingsModal = lazy(() =>
  import('./SettingsModal').then((module) => ({ default: module.SettingsModal })),
)
