import { lazy } from 'react'

export const TemplateSettingsDialog = lazy(() =>
  import('@admin/shared/dialogs/TemplateSettingsDialog').then((m) => ({ default: m.TemplateSettingsDialog })),
)
export const PageSettingsDialog = lazy(() =>
  import('@admin/shared/dialogs/PageSettingsDialog').then((m) => ({ default: m.PageSettingsDialog })),
)
