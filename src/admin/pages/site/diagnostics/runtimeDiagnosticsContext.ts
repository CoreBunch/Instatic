/**
 * The runtime-script build result, shared with everything that reports it.
 *
 * `useRuntimeScriptDiagnostics()` posts the draft to the server to be built,
 * so it runs exactly once (in `AdminCanvasLayout`) and the summary travels
 * through this context. The Site Explorer sits several components below the
 * toolbar that already receives it, and neither the sidebar nor the panel
 * shell has any reason to know about diagnostics, so a context beats
 * threading the prop through them.
 *
 * UI-ephemeral state, deliberately not the editor store: nothing here is part
 * of the document or survives a reload.
 */
import { createContext, use } from 'react'
import { summarizeRuntimeDiagnostics, type RuntimeDiagnosticsSummary } from '@core/site-runtime'

const EMPTY_SUMMARY: RuntimeDiagnosticsSummary = summarizeRuntimeDiagnostics([])

export const RuntimeDiagnosticsContext = createContext<RuntimeDiagnosticsSummary>(EMPTY_SUMMARY)

/**
 * The current build's problems. Outside the provider (unit renders of a single
 * panel) this reports a clean build, so consumers never branch on "no provider".
 */
export function useRuntimeDiagnostics(): RuntimeDiagnosticsSummary {
  return use(RuntimeDiagnosticsContext)
}
