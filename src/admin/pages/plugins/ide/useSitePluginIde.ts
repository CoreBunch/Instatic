/**
 * useSitePluginIde — the Plugin IDE's view-model hook.
 *
 * Owns one `IdeCollabSession` for the page's lifetime (live co-edited files
 * over the site socket), the plugin's summary/state from the list endpoint,
 * debounced auto-validation after edits, and the lifecycle actions
 * (activate / rollback / deactivate / delete / preview) with the same
 * step-up retry pattern the Plugins page uses.
 */
import { useEffect, useRef, useState, useSyncExternalStore, useCallback } from 'react'
import { apiRequest } from '@core/http'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  SitePluginsPayloadSchema,
  type SitePluginSummary,
} from '@core/site-plugins'
import { pushToast } from '@ui/components/Toast'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { useNavigate } from '@admin/lib/routing'
import { createIdeCollabSession, type IdeCollabSession, type IdeFileMeta } from './ideCollab'

const ValidateResponseSchema = Type.Object({
  ok: Type.Boolean(),
  diagnostics: Type.Array(Type.String()),
})

const AUTO_VALIDATE_DEBOUNCE_MS = 900

export interface SitePluginIdeVm {
  /** Null for at most one render — the mount effect creates it. */
  session: IdeCollabSession | null
  files: IdeFileMeta[]
  synced: boolean
  activeFileId: string | null
  selectFile: (fileId: string | null) => void
  summary: SitePluginSummary | null
  refreshSummary: () => Promise<void>
  diagnostics: string[]
  validating: boolean
  runValidation: () => void
  activating: boolean
  activate: () => Promise<void>
  rollback: () => Promise<void>
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
  const sessionRef = useRef<IdeCollabSession | null>(null)
  const [synced, setSynced] = useState(false)
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [summary, setSummary] = useState<SitePluginSummary | null>(null)
  const [diagnostics, setDiagnostics] = useState<string[]>([])
  const [validating, setValidating] = useState(false)
  const [activating, setActivating] = useState(false)
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const validateSeq = useRef(0)

  useEffect(() => {
    const created = createIdeCollabSession(localId)
    sessionRef.current = created
    let alive = true
    // Deferred so the effect body never sets state synchronously (lint rule
    // react-hooks/set-state-in-effect) — one tick is invisible next to the
    // socket round-trip anyway.
    const publish = setTimeout(() => {
      if (!alive) return
      setSession(created)
      setSynced(created.synced())
      setActiveFileId(null)
    }, 0)
    void created.whenSynced.then(() => {
      if (!alive) return
      setSynced(true)
    })
    return () => {
      alive = false
      clearTimeout(publish)
      sessionRef.current = null
      created.destroy()
    }
  }, [localId])

  // Files metadata via useSyncExternalStore — content keystrokes fire the
  // underlying observer too, so the snapshot is signature-cached and only
  // re-renders on structural/metadata changes.
  const filesCache = useRef<{ signature: string; files: IdeFileMeta[] }>({
    signature: '',
    files: [],
  })
  const subscribeFiles = useCallback(
    (onStoreChange: () => void) => session?.onFilesChange(onStoreChange) ?? (() => {}),
    [session],
  )
  const getFilesSnapshot = useCallback((): IdeFileMeta[] => {
    const files = session?.pluginFiles() ?? []
    const signature = files.map((file) => `${file.id}:${file.path}`).join('|')
    if (signature !== filesCache.current.signature) {
      filesCache.current = { signature, files }
    }
    return filesCache.current.files
  }, [session])
  const files = useSyncExternalStore(subscribeFiles, getFilesSnapshot)

  const refreshSummary = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiRequest('/admin/api/cms/site-plugins', {
        schema: SitePluginsPayloadSchema,
      })
      setSummary(payload.sitePlugins.find((entry) => entry.localId === localId) ?? null)
    } catch (err) {
      console.error('[SitePluginIde] summary load failed:', err)
    }
  }, [localId])

  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshSummary()
    }, 0)
    return () => clearTimeout(timer)
  }, [refreshSummary])

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
    void refreshSummary()
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

  const activate = useCallback(async (): Promise<void> => {
    setActivating(true)
    try {
      await runStepUp(() =>
        apiRequest(`/admin/api/cms/site-plugins/${localId}/activate`, { method: 'POST' }),
      )
      pushToast({ kind: 'success', title: 'Site plugin activated' })
      await refreshSummary()
    } catch (err) {
      if (!(err instanceof Error && err.message === StepUpCancelledMessage)) {
        pushToast({
          kind: 'error',
          title: 'Build & activate failed',
          body: getErrorMessage(err, 'Unknown activation error'),
        })
        runValidation()
      }
    } finally {
      setActivating(false)
    }
  }, [localId, refreshSummary, runStepUp, runValidation])

  const rollback = useCallback(async (): Promise<void> => {
    try {
      await runStepUp(() =>
        apiRequest(`/admin/api/cms/site-plugins/${localId}/rollback`, { method: 'POST' }),
      )
      pushToast({ kind: 'success', title: 'Rolled back to the previous revision' })
      await refreshSummary()
    } catch (err) {
      if (!(err instanceof Error && err.message === StepUpCancelledMessage)) {
        pushToast({
          kind: 'error',
          title: 'Rollback failed',
          body: getErrorMessage(err, 'Unknown rollback error'),
        })
      }
    }
  }, [localId, refreshSummary, runStepUp])

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      try {
        await runStepUp(() =>
          apiRequest(`/admin/api/cms/plugins/site.${localId}`, {
            method: 'PATCH',
            body: { enabled },
          }),
        )
        await refreshSummary()
      } catch (err) {
        if (!(err instanceof Error && err.message === StepUpCancelledMessage)) {
          pushToast({
            kind: 'error',
            title: enabled ? 'Could not activate' : 'Could not deactivate',
            body: getErrorMessage(err, 'Unknown error'),
          })
        }
      }
    },
    [localId, refreshSummary, runStepUp],
  )

  const restart = useCallback(async (): Promise<void> => {
    try {
      await runStepUp(() =>
        apiRequest(`/admin/api/cms/plugins/site.${localId}/restart`, { method: 'POST' }),
      )
      pushToast({ kind: 'success', title: 'Plugin restarted' })
      await refreshSummary()
    } catch (err) {
      if (!(err instanceof Error && err.message === StepUpCancelledMessage)) {
        pushToast({
          kind: 'error',
          title: 'Restart failed',
          body: getErrorMessage(err, 'Unknown error'),
        })
      }
    }
  }, [localId, refreshSummary, runStepUp])

  const deletePlugin = useCallback(async (): Promise<void> => {
    try {
      await runStepUp(() =>
        apiRequest(`/admin/api/cms/site-plugins/${localId}`, { method: 'DELETE' }),
      )
      pushToast({ kind: 'success', title: 'Site plugin deleted' })
      navigate('/admin/plugins')
    } catch (err) {
      if (!(err instanceof Error && err.message === StepUpCancelledMessage)) {
        pushToast({
          kind: 'error',
          title: 'Delete failed',
          body: getErrorMessage(err, 'Unknown error'),
        })
      }
    }
  }, [localId, navigate, runStepUp])

  const openPreview = useCallback((): void => {
    navigate(`/admin/site?previewSitePlugin=${encodeURIComponent(localId)}`)
  }, [localId, navigate])

  return {
    session,
    files,
    synced,
    activeFileId,
    selectFile: setActiveFileId,
    summary,
    refreshSummary,
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
