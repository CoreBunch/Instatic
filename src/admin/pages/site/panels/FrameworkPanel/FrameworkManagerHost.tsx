/**
 * FrameworkManagerHost — mounts the Manage Core Framework dialog inside the
 * site editor, wiring it to the live store. The dialog picks one declarative
 * target state; `setFrameworkPreset` reconciles to it (with undo). Reads the
 * current state and used-class count from the live site for the dialog's
 * pre-selection and remove warning.
 */
import { useEditorStore } from '@site/store/store'
import { collectUsedFrameworkClassIds, frameworkUtilityState } from '@core/framework'
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
  const usedFrameworkClassCount = site ? collectUsedFrameworkClassIds(site).size : 0

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
      usedFrameworkClassCount={usedFrameworkClassCount}
    />
  )
}
