/**
 * FrameworkManagerHost — mounts the Manage Core Framework dialog inside the
 * site editor, wiring it to the live store actions (import + remove + prune,
 * each through reconcile + undo). Reads `hasFramework` and the used-class count
 * from the live site for the dialog's state-aware UI and remove warning.
 */
import { useEditorStore } from '@site/store/store'
import { collectUsedFrameworkClassIds } from '@core/framework'
import {
  FrameworkManagerDialog,
  type FrameworkManagerApplier,
} from '@admin/shared/dialogs/FrameworkManagerDialog'

export function FrameworkManagerHost() {
  const open = useEditorStore((s) => s.frameworkManagerOpen)
  const setOpen = useEditorStore((s) => s.setFrameworkManagerOpen)
  const site = useEditorStore((s) => s.site)
  const importCoreFramework = useEditorStore((s) => s.importCoreFramework)
  const removeFrameworkCompletely = useEditorStore((s) => s.removeFrameworkCompletely)
  const pruneUnusedFrameworkClasses = useEditorStore((s) => s.pruneUnusedFrameworkClasses)

  const hasFramework = Boolean(site?.settings.framework)
  const usedFrameworkClassCount = site ? collectUsedFrameworkClassIds(site).size : 0

  const applier: FrameworkManagerApplier = {
    capabilities: { canRemove: true },
    import: async (mode) => importCoreFramework(mode),
    removeAll: async () => removeFrameworkCompletely(),
    pruneUnused: async () => pruneUnusedFrameworkClasses(),
  }

  return (
    <FrameworkManagerDialog
      open={open}
      onClose={() => setOpen(false)}
      applier={applier}
      hasFramework={hasFramework}
      usedFrameworkClassCount={usedFrameworkClassCount}
    />
  )
}
