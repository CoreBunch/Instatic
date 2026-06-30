/**
 * FrameworkManagerHost — mounts the Manage Core Framework dialog inside the
 * site editor, wiring it to the live store. The dialog picks one declarative
 * target state; `setFrameworkPreset` reconciles to it (with undo). The current
 * state pre-selects a card; the destructive-change confirmation is handled by
 * the shared FrameworkChangeConfirm flow inside the dialog.
 */
import { useEditorStore } from '@site/store/store'
import { frameworkUtilityState } from '@core/framework'
import {
  FrameworkManagerDialog,
  type FrameworkManagerApplier,
} from '@admin/shared/dialogs/FrameworkManagerDialog'

export function FrameworkManagerHost() {
  const open = useEditorStore((s) => s.frameworkManagerOpen)
  const setOpen = useEditorStore((s) => s.setFrameworkManagerOpen)
  const site = useEditorStore((s) => s.site)
  const setFrameworkPreset = useEditorStore((s) => s.setFrameworkPreset)

  const currentState = frameworkUtilityState(site?.settings.framework)

  const applier: FrameworkManagerApplier = {
    capabilities: { canRemove: true },
    apply: async (target) => setFrameworkPreset(target),
  }

  return (
    <FrameworkManagerDialog
      open={open}
      onClose={() => setOpen(false)}
      applier={applier}
      currentState={currentState}
    />
  )
}
