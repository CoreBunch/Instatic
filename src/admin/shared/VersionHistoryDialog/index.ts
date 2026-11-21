import { lazy } from 'react'

// Both editor toolbars load the history dialog on first open.
export const VersionHistoryDialog = lazy(() =>
  import('./VersionHistoryDialog').then((module) => ({ default: module.VersionHistoryDialog })),
)
