/**
 * Binds `api.editor.fragments` (inserts and themes) for plugins while the
 * site editor body is mounted and the user can edit the draft site
 * (`enabled`). The host closes over the admin shell's step-up runner (server
 * writes may ask for the password) and loads the insert and theme flows on
 * first use, so the planners stay out of the editor body's chunk.
 */

import { useEffect, useRef } from 'react'
import { bindPluginRuntimeFragmentsHost } from '@core/plugins/runtime'
import { resolveCanvasPointerInsertionDrop } from '@site/canvas/canvasInsertionDrop'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { useStepUp } from '@admin/shared/StepUp'
import { captureFragmentTarget, capturePreviewBranch, captureThemeTarget } from './fragmentInsertTarget'

const loadHost = () => import('./pluginFragmentsHost')

export function useBindPluginFragmentsApi(enabled: boolean): void {
  const { runStepUp } = useStepUp()
  const stepUp = useRef(runStepUp)
  useEffect(() => {
    stepUp.current = runStepUp
  }, [runStepUp])

  useEffect(() => {
    if (!enabled) return
    // Keep previews subscribed when the step-up provider renders its prompt.
    const confirm: typeof runStepUp = (action) => stepUp.current(action)
    const closePreviews = new Set<() => void>()
    const unbind = bindPluginRuntimeFragmentsHost({
      canvasDropAt(clientX, clientY) {
        const canvasPage = selectActiveCanvasPage(useEditorStore.getState())
        if (!canvasPage) return null
        const drop = resolveCanvasPointerInsertionDrop({ canvasPage, clientX, clientY, label: 'Insert' })
        if (!drop) return null
        const target = captureFragmentTarget()
        return {
          preview: drop.preview,
          async insert(input) {
            return (await loadHost()).insertFragmentForPlugin(input, confirm, target, drop.location)
          },
        }
      },
      watchPreviewStyles(onChange) {
        let active = true
        let unsubscribe: (() => void) | undefined
        function stop() {
          active = false
          unsubscribe?.()
          closePreviews.delete(close)
        }
        function close() {
          stop()
          onChange(null)
        }
        closePreviews.add(close)
        void loadHost().then((host) => {
          if (!active) return
          const release = host.watchFragmentPreviewStyles(onChange)
          if (active) unsubscribe = release
          else release()
        }).catch((err) => {
          if (!active) return
          console.error('[fragment-preview] Could not load site styles:', err)
          close()
        })
        return stop
      },
      async insert(input) {
        const target = captureFragmentTarget()
        return (await loadHost()).insertFragmentForPlugin(input, confirm, target)
      },
      async plan(input) {
        const target = capturePreviewBranch()
        return (await loadHost()).planFragmentForPlugin(input, target)
      },
      async applyTheme(input) {
        const target = captureThemeTarget()
        return (await loadHost()).applyThemeForPlugin(input, confirm, target)
      },
      async planTheme(input) {
        const target = captureThemeTarget()
        return (await loadHost()).planThemeForPlugin(input, target)
      },
    })
    return () => {
      unbind()
      for (const close of closePreviews) close()
    }
  }, [enabled])
}
