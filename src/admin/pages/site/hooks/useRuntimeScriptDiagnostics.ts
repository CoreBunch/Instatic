import { useEffect, useEffectEvent, useState } from 'react'
import { isAbortError } from '@core/http'
import { validateCmsRuntimeScripts } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import type { SiteRuntimeDiagnostic } from '@core/site-runtime'
import { useEditorStore } from '@site/store/store'

export type RuntimeScriptValidationStatus =
  | 'idle'
  | 'validating'
  | 'valid'
  | 'unavailable'

export interface RuntimeScriptValidationState {
  status: RuntimeScriptValidationStatus
  diagnostics: SiteRuntimeDiagnostic[]
  errorMessage?: string
}

const EMPTY_VALIDATION: RuntimeScriptValidationState = {
  status: 'idle',
  diagnostics: [],
}

const VALIDATION_DELAY_MS = 450

function hasEnabledRuntimeScripts(): boolean {
  const site = useEditorStore.getState().site
  if (!site) return false
  const runtime = normalizeSiteRuntimeConfig(site.runtime)
  return site.files.some((file) => (
    file.type === 'script' && (runtime.scripts[file.id]?.enabled ?? true)
  ))
}

/**
 * Continuously compiles the in-memory draft after script/runtime changes.
 * Autosave remains independent: invalid intermediate text is still persisted,
 * while this state drives IDE diagnostics and the Publish safety gate.
 */
export function useRuntimeScriptDiagnostics(): RuntimeScriptValidationState {
  const siteId = useEditorStore((state) => state.site?.id ?? null)
  const files = useEditorStore((state) => state.site?.files ?? null)
  const runtime = useEditorStore((state) => state.site?.runtime ?? null)
  const packageJson = useEditorStore((state) => state.site?.packageJson ?? null)
  const [validation, setValidation] = useState<RuntimeScriptValidationState>(EMPTY_VALIDATION)

  const validateLatestDraft = useEffectEvent(async (controller: AbortController) => {
    const site = useEditorStore.getState().site
    if (!site) return

    try {
      const diagnostics = await validateCmsRuntimeScripts(site, {
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setValidation({ status: 'valid', diagnostics })
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return
      setValidation({
        status: 'unavailable',
        diagnostics: [],
        errorMessage: getErrorMessage(err, 'Code validation is temporarily unavailable.'),
      })
    }
  })

  useEffect(() => {
    if (!siteId || !files || !hasEnabledRuntimeScripts()) {
      const resetTimer = setTimeout(() => setValidation(EMPTY_VALIDATION), 0)
      return () => clearTimeout(resetTimer)
    }

    const controller = new AbortController()
    const checkingTimer = setTimeout(() => {
      setValidation((current) => ({
        status: 'validating',
        diagnostics: current.diagnostics,
      }))
    }, 0)
    const timer = setTimeout(() => {
      void validateLatestDraft(controller)
    }, VALIDATION_DELAY_MS)

    return () => {
      clearTimeout(checkingTimer)
      clearTimeout(timer)
      controller.abort()
    }
  }, [files, packageJson, runtime, siteId])

  return validation
}

/** The compiler diagnostics that belong to one script file. */
export function fileRuntimeDiagnostics(
  diagnostics: readonly SiteRuntimeDiagnostic[],
  file: { id: string; path: string },
): SiteRuntimeDiagnostic[] {
  return diagnostics.filter((diagnostic) => (
    diagnostic.fileId === file.id || (!diagnostic.fileId && diagnostic.path === file.path)
  ))
}
