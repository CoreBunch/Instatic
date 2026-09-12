/**
 * useSitePluginIde — the Plugin IDE's view-model hook.
 *
 * Owns one `IdeCollabSession` for the page's lifetime (live co-edited files
 * over the site socket), the plugin's summary/state from the list endpoint,
 * debounced auto-validation after edits, and the lifecycle actions
 * (activate / rollback / deactivate / delete / preview) with the same
 * step-up retry pattern the Plugins page uses.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { apiRequest } from '@core/http'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  SitePluginsPayloadSchema,
  sitePluginDisplayVersion,
  type SitePluginSummary,
} from '@core/site-plugins'
import { pushToast } from '@ui/components/Toast'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useNavigate } from '@admin/lib/routing'
import { notifyCmsPluginsChanged } from '@plugins/utils/pluginEvents'
import { createIdeCollabSession, type IdeCollabSession, type IdeFileMeta } from './ideCollab'

const ValidateResponseSchema = Type.Object({
  ok: Type.Boolean(),
  diagnostics: Type.Array(Type.String()),
})

/** Every lifecycle route may carry a non-fatal warning (a failed republish). */
const LifecycleResponseSchema = Type.Object({
  warning: Type.Optional(Type.String()),
})

const AUTO_VALIDATE_DEBOUNCE_MS = 900
const NO_FILES: IdeFileMeta[] = []
const noop = (): void => {}

interface SitePluginIdeVm {
  /** Null for at most one render — the mount effect creates it. */
  session: IdeCollabSession | null
  files: IdeFileMeta[]
  synced: boolean
  /** Bumps on every relay reset — the editor buffer remounts on it. */
  generation: number
  activeFileId: string | null
  selectFile: (fileId: string | null) => void
  summary: SitePluginSummary | null
  diagnostics: string[]
  validating: boolean
  runValidation: () => void
  activating: boolean
  activate: () => Promise<void>
  /** Re-activate one of the retained builds (`summary.revisions`). */
  rollback: (version: string) => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  restart: () => Promise<void>
  deletePlugin: () => Promise<void>
  openPreview: () => void
}

export function useSitePluginIde(localId: string): SitePluginIdeVm {
  const { runStepUp } = useStepUp()
  const navigate = useNavigate()

  // One session per (mounted page, localId) — StrictMode-safe via ref-count
  // free create/destroy in the effect below.
  const [session, setSession] = useState<IdeCollabSession | null>(null)
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<string[]>([])
  const [validating, setValidating] = useState(false)
  const [activating, setActivating] = useState(false)
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const validateSeq = useRef(0)

  useEffect(() => {
    const created = createIdeCollabSession(localId)
    let alive = true
    // Deferred so the effect body never sets state synchronously (lint rule
    // react-hooks/set-state-in-effect) — one tick is invisible next to the
    // socket round-trip anyway.
    const publish = setTimeout(() => {
      if (!alive) return
      setSession(created)
      setActiveFileId(null)
    }, 0)
    return () => {
      alive = false
      clearTimeout(publish)
      created.destroy()
    }
  }, [localId])

  // Sync state and the rebind generation come straight from the session —
  // both flip on a relay reset (synced → false → true, generation + 1), and
  // the editor buffer remounts on the generation.
  // useCallback kept: useSyncExternalStore resubscribes on identity change.
  const subscribeSync = useCallback(
    (onStoreChange: () => void) => session?.onSyncChange(onStoreChange) ?? noop,
    [session],
  )
  const synced = useSyncExternalStore(subscribeSync, () => session?.synced() ?? false)
  const generation = useSyncExternalStore(subscribeSync, () => session?.generation() ?? 0)

  // File metadata. The session hands back the same array until an id or a
  // path changes, so content keystrokes (which fire the same observer)
  // never re-render the tree.
  // useCallback kept: same reason as subscribeSync.
  const subscribeFiles = useCallback(
    (onStoreChange: () => void) => session?.onFilesChange(onStoreChange) ?? noop,
    [session],
  )
  const files = useSyncExternalStore(subscribeFiles, () => session?.pluginFiles() ?? NO_FILES)

  // The runtime summary (state chip, grants, active version): one GET, the
  // canonical single-resource shape.
  const summaryResource = useAsyncResource(
    (signal) =>
      apiRequest('/admin/api/cms/site-plugins', {
        schema: SitePluginsPayloadSchema,
        signal,
      }).then(
        (payload) => payload.sitePlugins.find((entry) => entry.localId === localId) ?? null,
      ),
    [localId],
    { fallbackError: 'Could not load the plugin state' },
  )
  const summary = summaryResource.data
  const refreshSummary = summaryResource.refresh
  useEffect(() => {
    if (summaryResource.error) {
      console.error('[SitePluginIde] summary load failed:', summaryResource.error)
    }
  }, [summaryResource.error])

  // useCallback kept: runValidation is a dependency of the effects below.
  const runValidation = useCallback((): void => {
    const seq = ++validateSeq.current
    setValidating(true)
    void apiRequest(`/admin/api/cms/site-plugins/${localId}/validate`, {
      method: 'POST',
      schema: ValidateResponseSchema,
    })
      .then((result) => {
        if (seq !== validateSeq.current) return
        setDiagnostics(result.diagnostics)
      })
      .catch((err: unknown) => {
        if (seq !== validateSeq.current) return
        setDiagnostics([getErrorMessage(err, 'Validation failed')])
      })
      .finally(() => {
        if (seq === validateSeq.current) setValidating(false)
      })
    // State chips (draft-changed vs active) key off the content hash — keep
    // the summary fresh alongside diagnostics.
    refreshSummary()
  }, [localId, refreshSummary])

  // Automatic validation — debounced on every file change (metadata or
  // content; the session notifies for both). The relay persists on ~800 ms
  // debounce, so waiting slightly longer keeps validate reading the same
  // draft the build would.
  useEffect(() => {
    if (!session || !synced) return
    const off = session.onFilesChange(() => {
      if (validateTimer.current) clearTimeout(validateTimer.current)
      validateTimer.current = setTimeout(() => {
        validateTimer.current = null
        runValidation()
      }, AUTO_VALIDATE_DEBOUNCE_MS)
    })
    return () => {
      off()
      if (validateTimer.current) {
        clearTimeout(validateTimer.current)
        validateTimer.current = null
      }
    }
  }, [session, synced, runValidation])

  // First-load validation once synced — diagnostics should not require a
  // keystroke to appear.
  useEffect(() => {
    if (!synced) return
    const timer = setTimeout(() => runValidation(), 0)
    return () => clearTimeout(timer)
  }, [synced, runValidation])

  /**
   * Every lifecycle action has the same shape: a step-up-aware request, a
   * success toast, a nudge to open editors (so a new revision's module pack
   * or editor entrypoint loads without a reload), then a summary refresh.
   * A cancelled step-up is silent; anything else toasts as an error.
   */
  const runLifecycle = async (
    request: () => Promise<{ warning?: string }>,
    labels: { success: string | null; failure: string },
    hooks: { after?: () => void; onFailure?: () => void } = {},
  ): Promise<void> => {
    try {
      const result = await runStepUp(request)
      if (labels.success) pushToast({ kind: 'success', title: labels.success })
      if (result.warning) {
        pushToast({ kind: 'warning', title: 'Completed with a warning', body: result.warning })
      }
      notifyCmsPluginsChanged()
      ;(hooks.after ?? refreshSummary)()
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      pushToast({ kind: 'error', title: labels.failure, body: getErrorMessage(err, 'Unknown error') })
      hooks.onFailure?.()
    }
  }

  const lifecycleRequest =
    (path: string, init: { method: 'POST' | 'PATCH' | 'DELETE'; body?: unknown }) =>
    () =>
      apiRequest(path, { ...init, schema: LifecycleResponseSchema })

  const activate = async (): Promise<void> => {
    setActivating(true)
    try {
      await runLifecycle(
        lifecycleRequest(`/admin/api/cms/site-plugins/${localId}/activate`, { method: 'POST' }),
        { success: 'Site plugin activated', failure: 'Build & activate failed' },
        { onFailure: runValidation },
      )
    } finally {
      setActivating(false)
    }
  }

  const rollback = (version: string): Promise<void> =>
    runLifecycle(
      lifecycleRequest(`/admin/api/cms/site-plugins/${localId}/rollback`, {
        method: 'POST',
        body: { version },
      }),
      { success: `Rolled back to v${sitePluginDisplayVersion(version)}`, failure: 'Rollback failed' },
    )

  const setEnabled = (enabled: boolean): Promise<void> =>
    runLifecycle(
      lifecycleRequest(`/admin/api/cms/plugins/site.${localId}`, {
        method: 'PATCH',
        body: { enabled },
      }),
      { success: null, failure: enabled ? 'Could not activate' : 'Could not deactivate' },
    )

  const restart = (): Promise<void> =>
    runLifecycle(
      lifecycleRequest(`/admin/api/cms/plugins/site.${localId}/restart`, { method: 'POST' }),
      { success: 'Plugin restarted', failure: 'Restart failed' },
    )

  const deletePlugin = (): Promise<void> =>
    runLifecycle(
      lifecycleRequest(`/admin/api/cms/site-plugins/${localId}`, { method: 'DELETE' }),
      { success: 'Site plugin deleted', failure: 'Delete failed' },
      { after: () => navigate('/admin/plugins') },
    )

  const openPreview = (): void => {
    navigate(`/admin/site?previewSitePlugin=${encodeURIComponent(localId)}`)
  }

  return {
    session,
    files,
    synced,
    generation,
    activeFileId,
    selectFile: setActiveFileId,
    summary,
    diagnostics,
    validating,
    runValidation,
    activating,
    activate,
    rollback,
    setEnabled,
    restart,
    deletePlugin,
    openPreview,
  }
}
