import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ChangeEvent, RefObject } from 'react'
import { consumePendingAction } from '@admin/spotlight/pendingAction'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import {
  inspectCmsPluginPackage,
  installCmsPluginManifest,
  installCmsPluginPack,
  installCmsPluginPackage,
  listCmsPlugins,
  removeCmsPlugin,
  restartCmsPlugin,
  setCmsPluginEnabled,
} from '@core/persistence'
import {
  collectEnabledAdminPages,
  parsePluginManifest,
} from '@core/plugins/manifest'
import type {
  CmsPluginsPayload,
  InstalledPlugin,
  PluginManifest,
  PluginPermission,
} from '@core/plugin-sdk'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import type { WorkspaceLoadState } from '@admin/lib/workspaceLoadState'
import {
  getEditorActivationErrors,
  subscribeEditorActivationErrors,
} from './editorPluginActivationErrors'
import { notifyCmsPluginsChanged } from '../utils/pluginEvents'
import { subscribePluginEvents } from '../utils/pluginEventStream'
import { getErrorMessage } from '@core/utils/errorMessage'
import { ApiError } from '@core/http'
import { pushToast } from '@ui/components/Toast'

/**
 * Per-install state for the confirmation dialog. The dialog renders different
 * copy for upgrade vs. fresh install and highlights NEW permissions against
 * `previouslyGrantedPermissions`. Lives on the workspace hook because the
 * dialog is conceptually a sub-step of the install action.
 */
export interface PendingInstall {
  manifest: PluginManifest
  file?: File
  /**
   * If set, this upload upgrades an already-installed plugin from the given
   * version to `manifest.version`. The dialog switches to upgrade-aware copy
   * ("Update X from 1.0.0 to 1.1.0") and the confirm button reflects the verb.
   */
  upgradeFromVersion?: string
  /**
   * Permissions the user previously granted to the existing install. Used by
   * the dialog to compute the diff against the new manifest's requested
   * permissions and prominently highlight any new ones.
   */
  previouslyGrantedPermissions?: PluginPermission[]
  /**
   * `networkAllowedHosts` from the manifest of the existing install (when
   * this is an upgrade). The dialog diffs it against the new manifest's
   * value so an upgrade adding new external hosts shows them as "New".
   */
  previousNetworkAllowedHosts?: string[]
}

/**
 * Confirmation-dialog state for plugin removal. `force: true` means the
 * server will skip the plugin's lifecycle hooks — offered only after a
 * normal uninstall failed on a hook error.
 */
export interface PendingRemove {
  plugin: InstalledPlugin
  force: boolean
}

/**
 * A normal uninstall that failed because a lifecycle hook (`deactivate` /
 * `uninstall`) threw or the entry file could not load. Rendered as an alert
 * with a "Remove anyway" action that re-runs the removal with `force: true`.
 */
export interface RemoveFailure {
  plugin: InstalledPlugin
  message: string
}

/**
 * Read-only view-model returned to `PluginsPage`. Splits state, mutators that
 * drive dialogs, and async actions so the render component stays declarative.
 */
export interface PluginsWorkspaceVM extends WorkspaceLoadState {
  fileInputRef: RefObject<HTMLInputElement | null>
  payload: CmsPluginsPayload
  uploading: boolean
  busyPluginId: string | null
  editorActivationErrors: Record<string, string>
  pendingInstall: PendingInstall | null
  settingsPluginId: string | null
  schedulesPluginId: string | null
  pendingRemove: PendingRemove | null
  removeFailure: RemoveFailure | null

  // Dialog open / close mutators.
  setPendingInstall: (value: PendingInstall | null) => void
  setSettingsPluginId: (value: string | null) => void
  setSchedulesPluginId: (value: string | null) => void
  setPendingRemove: (value: PendingRemove | null) => void
  setRemoveFailure: (value: RemoveFailure | null) => void

  // Async actions.
  loadPlugins: () => Promise<void>
  handleUpload: (event: ChangeEvent<HTMLInputElement>) => Promise<void>
  installPendingPlugin: (
    pending: PendingInstall,
    grantedPermissions?: PluginPermission[],
  ) => Promise<void>
  togglePlugin: (plugin: InstalledPlugin) => Promise<void>
  restartPlugin: (plugin: InstalledPlugin) => Promise<void>
  installPluginPack: (plugin: InstalledPlugin) => Promise<void>
  executeRemovePlugin: (plugin: InstalledPlugin, force: boolean) => Promise<void>
}

const emptyPayload: CmsPluginsPayload = { plugins: [], adminPages: [] }

function notifyCmsSiteReload(): void {
  requestCmsSiteReload()
}

/**
 * Heuristic — does this error message look like it came from the plugin
 * sandbox layer? Used by `PluginsPage` to decide whether to attach the
 * sandbox-docs hint next to the error alert.
 */
export function isSandboxRelatedError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('sandbox') ||
    lower.includes("'node:") ||
    lower.includes('"node:') ||
    lower.includes("'bun:") ||
    lower.includes('could not load module') ||
    lower.includes('forbidden literal') ||
    lower.includes('requires permission') ||
    lower.includes('networkallowedhosts')
  )
}

function updatePluginInPayload(
  payload: CmsPluginsPayload,
  plugin: InstalledPlugin,
): CmsPluginsPayload {
  const existing = payload.plugins.findIndex(
    (candidate) => candidate.id === plugin.id,
  )
  const plugins =
    existing === -1
      ? [plugin, ...payload.plugins]
      : payload.plugins.map((candidate) =>
          candidate.id === plugin.id ? plugin : candidate,
        )
  return { plugins, adminPages: collectEnabledAdminPages(plugins) }
}

/**
 * Shape returned by the plugin-mutating endpoints. They may return either the
 * full collection (after lifecycle hooks rewrite multiple plugin rows) or a
 * single row (after a localized edit). `applyPluginResult` collapses both
 * cases into a payload update.
 */
interface PluginMutationResult {
  plugins: InstalledPlugin[]
  adminPages: CmsPluginsPayload['adminPages']
  plugin?: InstalledPlugin
}

export function usePluginsWorkspace(): PluginsWorkspaceVM {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const { runStepUp } = useStepUp()

  const [payload, setPayload] = useState<CmsPluginsPayload>(emptyPayload)
  const [loading, setLoading] = useState(true)
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingInstall, setPendingInstall] = useState<PendingInstall | null>(null)
  const [settingsPluginId, setSettingsPluginId] = useState<string | null>(null)
  const [schedulesPluginId, setSchedulesPluginId] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<PendingRemove | null>(null)
  const [removeFailure, setRemoveFailure] = useState<RemoveFailure | null>(null)

  // Editor-side activation failures (per pluginId → error message). Populated
  // by `useInstalledEditorPlugins` after each refresh; surfaced on the plugin
  // card alongside the server-side `lastError`.
  const editorActivationErrors = useSyncExternalStore(
    subscribeEditorActivationErrors,
    getEditorActivationErrors,
    getEditorActivationErrors,
  )

  function applyPluginResult(result: PluginMutationResult): void {
    if (result.plugins.length > 0) {
      setPayload({ plugins: result.plugins, adminPages: result.adminPages })
      return
    }
    if (result.plugin) {
      const plugin = result.plugin
      setPayload((current) => updatePluginInPayload(current, plugin))
    }
  }

  async function loadPlugins(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      setPayload(await listCmsPlugins())
    } catch (err) {
      setError(getErrorMessage(err, 'Could not load plugins'))
    }
    setLoading(false)
  }

  /**
   * Shared per-plugin async action ladder. Every "click a button on the plugin
   * card" handler funnels through here so the busy state, step-up retry,
   * step-up cancellation, and error-surfacing behaviour stay in one place.
   */
  async function runPluginAction(
    pluginId: string,
    fn: () => Promise<PluginMutationResult>,
    fallbackError: string,
  ): Promise<void> {
    setBusyPluginId(pluginId)
    setError(null)
    try {
      applyPluginResult(await runStepUp(fn))
      notifyCmsPluginsChanged()
    } catch (err) {
      if (!(err instanceof Error && err.message === StepUpCancelledMessage)) {
        setError(getErrorMessage(err, fallbackError))
      }
    }
    setBusyPluginId(null)
  }

  async function installPendingPlugin(
    pending: PendingInstall,
    grantedPermissions?: PluginPermission[],
  ): Promise<void> {
    setUploading(true)
    setError(null)
    try {
      const pendingFile = pending.file
      const pendingManifest = pending.manifest
      const resolvedGrantedPermissions =
        grantedPermissions ?? pendingManifest.permissions
      // Installing / upgrading a plugin is a sensitive action — the server
      // requires a fresh `step_up` auth window. `runStepUp` runs the action
      // optimistically first; if the server replies `step_up_required`, it
      // pops a password-confirm dialog and retries.
      const result = await runStepUp(() =>
        pendingFile
          ? installCmsPluginPackage(pendingFile, resolvedGrantedPermissions)
          : installCmsPluginManifest(pendingManifest, resolvedGrantedPermissions),
      )
      if (result.plugins.length > 0) {
        setPayload({ plugins: result.plugins, adminPages: result.adminPages })
      } else if (result.plugin) {
        const plugin = result.plugin
        setPayload((current) => updatePluginInPayload(current, plugin))
      } else {
        await loadPlugins()
      }
      notifyCmsPluginsChanged()
      // Auto-install path on the server may have also imported the bundled
      // pack — refresh the editor's site state so any newly imported VCs /
      // pages / classes appear immediately.
      if (
        pending.manifest.pack &&
        resolvedGrantedPermissions.includes('visualComponents.register')
      ) {
        notifyCmsSiteReload()
      }
      setPendingInstall(null)
    } catch (err) {
      // User dismissed the step-up dialog — treat as no-op, not an error.
      if (!(err instanceof Error && err.message === StepUpCancelledMessage)) {
        setError(getErrorMessage(err, 'Could not install plugin'))
      }
    }
    setUploading(false)
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return

    setUploading(true)
    setError(null)
    try {
      const isZip = file.name.toLowerCase().endsWith('.zip')
      const manifest = isZip
        ? await inspectCmsPluginPackage(file)
        : parsePluginManifest(JSON.parse(await file.text()))

      // Detect upgrade vs. fresh install client-side so we can render the
      // right copy in the confirmation dialog. The server detects upgrades
      // independently — this is purely a UX hint.
      const existing = payload.plugins.find((p) => p.id === manifest.id)
      const upgradeFromVersion =
        existing && existing.version !== manifest.version ? existing.version : undefined
      const previouslyGrantedPermissions = existing
        ? existing.grantedPermissions
        : undefined
      const previousNetworkAllowedHosts = existing?.manifest.networkAllowedHosts

      // EVERY install and upgrade goes through the review dialog — including
      // a zero-permission declarative plugin, which renders "No permissions
      // requested" so the operator consciously approves what lands in their
      // CMS. Nothing installs silently.
      setPendingInstall({
        manifest,
        file: isZip ? file : undefined,
        upgradeFromVersion,
        previouslyGrantedPermissions,
        ...(previousNetworkAllowedHosts !== undefined
          ? { previousNetworkAllowedHosts }
          : {}),
      })
    } catch (err) {
      setError(getErrorMessage(err, 'Could not install plugin'))
    }
    setUploading(false)
  }

  async function togglePlugin(plugin: InstalledPlugin): Promise<void> {
    await runPluginAction(
      plugin.id,
      () => setCmsPluginEnabled(plugin.id, !plugin.enabled),
      'Could not update plugin',
    )
  }

  /**
   * Manually restart a plugin parked in `error` state. Resets the host's
   * crash budget for this plugin, clears its historical crash events, then
   * re-loads + re-activates. Used from the "Restart" button on the plugin
   * card.
   */
  async function restartPlugin(plugin: InstalledPlugin): Promise<void> {
    await runPluginAction(
      plugin.id,
      () => restartCmsPlugin(plugin.id),
      'Could not restart plugin',
    )
  }

  async function installPluginPack(plugin: InstalledPlugin): Promise<void> {
    setBusyPluginId(plugin.id)
    setError(null)
    try {
      const summary = await runStepUp(() => installCmsPluginPack(plugin.id))
      const installedCount =
        summary.installed.visualComponents.length +
        summary.installed.pages.length +
        summary.installed.classes.length +
        summary.installed.layouts.length
      const replacedCount =
        summary.replaced.visualComponents.length +
        summary.replaced.pages.length +
        summary.replaced.classes.length +
        summary.replaced.layouts.length
      pushToast({
        kind: 'success',
        title: `Installed pack from ${plugin.name}`,
        body: `${installedCount} item(s) added, ${replacedCount} replaced.`,
        location: 'plugins:install-pack',
      })
      notifyCmsPluginsChanged()
      // The pack writes Visual Components, pages, classes, and layouts
      // directly to the draft site at the DB level. Tell the editor's persistence layer to
      // re-pull so the new content shows up in the Site Explorer / canvas
      // without a full browser reload.
      notifyCmsSiteReload()
    } catch (err) {
      if (!(err instanceof Error && err.message === StepUpCancelledMessage)) {
        setError(getErrorMessage(err, 'Could not install plugin pack'))
      }
    }
    setBusyPluginId(null)
  }

  async function executeRemovePlugin(plugin: InstalledPlugin, force: boolean): Promise<void> {
    setBusyPluginId(plugin.id)
    setError(null)
    setRemoveFailure(null)
    try {
      await runStepUp(() => removeCmsPlugin(plugin.id, force))
      setPayload((current) => ({
        plugins: current.plugins.filter((candidate) => candidate.id !== plugin.id),
        adminPages: current.adminPages.filter((page) => page.pluginId !== plugin.id),
      }))
      notifyCmsPluginsChanged()
    } catch (err) {
      if (!(err instanceof Error && err.message === StepUpCancelledMessage)) {
        const message = getErrorMessage(err, 'Could not remove plugin')
        // A 400 from the DELETE endpoint means a lifecycle hook
        // (`deactivate` / `uninstall`) threw, or the entry file could not
        // load — the one failure class where the server offers the
        // force-remove escape hatch. Surface it as a removal failure with
        // a "Remove anyway" action instead of a dead-end error.
        if (!force && err instanceof ApiError && err.status === 400) {
          setRemoveFailure({ plugin, message })
        } else {
          setError(message)
        }
        // The DELETE flow mutates several server-side things before it can
        // fail (lifecycle status, worker state). Re-fetch the canonical list
        // so the card reflects reality regardless of the failure mode.
        await loadPlugins()
      }
    }
    setBusyPluginId(null)
  }

  // Auto-open the file picker when the spotlight queued a `plugins.install`
  // action from another workspace. Defer to the next tick so the input ref
  // is mounted before we trigger .click() on it.
  useEffect(() => {
    const pending = consumePendingAction('plugins.install')
    if (!pending) return
    const id = setTimeout(() => fileInputRef.current?.click(), 0)
    return () => clearTimeout(id)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPlugins()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  // Live refresh — when ANY plugin event arrives (crash, recovered, parked,
  // restarted, installed, updated, uninstalled, enabled, disabled), re-fetch
  // the list so the user sees the latest state without leaving the page. The
  // EventSource is shared across consumers (PluginsNavBadge, toast bridge)
  // so we don't open one socket per subscriber.
  useEffect(() => {
    const unsubscribe = subscribePluginEvents(() => {
      void loadPlugins()
    })
    return unsubscribe
  }, [])

  return {
    fileInputRef,
    payload,
    loading,
    uploading,
    busyPluginId,
    error,
    editorActivationErrors,
    pendingInstall,
    settingsPluginId,
    schedulesPluginId,
    pendingRemove,
    removeFailure,
    setPendingInstall,
    setSettingsPluginId,
    setSchedulesPluginId,
    setPendingRemove,
    setRemoveFailure,
    loadPlugins,
    handleUpload,
    installPendingPlugin,
    togglePlugin,
    restartPlugin,
    installPluginPack,
    executeRemovePlugin,
  }
}
