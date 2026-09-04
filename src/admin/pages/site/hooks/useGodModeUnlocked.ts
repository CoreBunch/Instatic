import { canEditStructure } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import {
  readEditorPreferenceBool,
  useEditorPreference,
} from '@site/preferences/editorPreferences'
import type { CmsCurrentUser } from '@core/persistence'

/**
 * The single God Mode gate: the `godMode` editor preference is enabled AND
 * the user holds structure-edit rights. Gates the toolbar toggle, the Code
 * Dock mount, and the ⌘⇧G spotlight command. See docs/features/god-mode.md.
 */
export function isGodModeUnlocked(user: CmsCurrentUser | null): boolean {
  return canEditStructure(user) && readEditorPreferenceBool('godMode')
}

/**
 * Reactive wrapper around `isGodModeUnlocked` — `useEditorPreference`
 * subscribes this component to preference changes so flipping the Settings
 * toggle updates the UI without a reload.
 */
export function useGodModeUnlocked(): boolean {
  useEditorPreference('godMode')
  return isGodModeUnlocked(useCurrentAdminUser())
}
