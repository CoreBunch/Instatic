/**
 * Binds `api.editor.fragments` for plugins while the site editor body is
 * mounted and the user can edit the draft site (`enabled`). The host closes
 * over the admin shell's step-up runner (table writes may ask for the
 * password) and loads the insert flow on first use, so the planner stays out
 * of the editor body's chunk.
 */

import { useEffect } from 'react'
import { bindPluginRuntimeFragmentsHost } from '@core/plugins/runtime'
import { useStepUp } from '@admin/shared/StepUp'

const loadHost = () => import('./pluginFragmentsHost')

export function useBindPluginFragmentsApi(enabled: boolean): void {
  const { runStepUp } = useStepUp()
  useEffect(() => {
    if (!enabled) return undefined
    return bindPluginRuntimeFragmentsHost({
      insert: async (input) => (await loadHost()).insertFragmentForPlugin(input, runStepUp),
      plan: async (input) => (await loadHost()).planFragmentForPlugin(input),
    })
  }, [enabled, runStepUp])
}
