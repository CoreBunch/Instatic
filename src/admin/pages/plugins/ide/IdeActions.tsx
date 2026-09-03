/**
 * IdeActions — the IDE toolbar's right slot: peer avatar stack, the runtime
 * state indicator, and ONE split button (the same control the site
 * toolbar's Publish uses): the state-appropriate primary action on the
 * left, every other action in the menu. Unavailable actions are disabled
 * with an inline reason, never hidden.
 */
import {
  sitePluginPrimaryAction,
  sitePluginStateLabel,
  type SitePluginRuntimeState,
  type SitePluginSummary,
} from '@core/site-plugins'
import { SplitButton, type SplitButtonMenuItem } from '@ui/components/SplitButton'
import { PeerAvatar } from '@site/collab/PeerAvatar'
import { ToolbarStatus, type ToolbarStatusTone } from '@site/toolbar/ToolbarStatus'
import type { IdePeer } from './idePresence'
import styles from './IdeActions.module.css'

/** The site toolbar's tone vocabulary, applied to the plugin's runtime state. */
function stateTone(state: SitePluginRuntimeState): ToolbarStatusTone {
  switch (state) {
    case 'active':
      return 'success'
    case 'permission-review':
      return 'warning'
    case 'build-failed':
    case 'runtime-error':
    case 'source-missing':
      return 'danger'
    case 'draft-changed':
    case 'disabled':
      return 'neutral'
  }
}

const INSTALL_REASON = 'Requires the plugins.install permission'
const LIFECYCLE_REASON = 'Requires the plugins.lifecycle permission'

interface IdeActionsProps {
  summary: SitePluginSummary | null
  peers: IdePeer[]
  /** plugins.install — build & activate, rollback, delete. */
  canInstall: boolean
  /** plugins.lifecycle — enable, deactivate, restart (server-gated + step-up). */
  canManageLifecycle: boolean
  activating: boolean
  onActivate: () => void
  onPreview: () => void
  onRollback: () => void
  onSetEnabled: (enabled: boolean) => void
  onRestart: () => void
  onRunDiagnostics: () => void
  /** Logs, settings, schedules and restart-after-crash live on the Plugins page. */
  onOpenPluginsPage: () => void
  onDelete: () => void
}

export function IdeActions({
  summary,
  peers,
  canInstall,
  canManageLifecycle,
  activating,
  onActivate,
  onPreview,
  onRollback,
  onSetEnabled,
  onRestart,
  onRunDiagnostics,
  onOpenPluginsPage,
  onDelete,
}: IdeActionsProps) {
  const state = summary?.state ?? null
  const primary = state ? sitePluginPrimaryAction(state) : null
  const uniquePeers = new Map(peers.map((peer) => [peer.user.id, peer]))

  // Same split as the server: install-class actions need plugins.install,
  // enable/disable/restart need plugins.lifecycle.
  const needsInstallCap =
    primary?.action === 'activate' || primary?.action === 'review' || primary?.action === 'delete'
  const needsLifecycleCap = primary?.action === 'enable'
  // `active` has no state action of its own: the left half keeps reading
  // "Build & activate" and says why there is nothing to build.
  const primaryLabel = primary && primary.action !== null ? primary.label : 'Build & activate'
  const primaryBlockedReason = !summary
    ? 'Loading the plugin state…'
    : primary?.action === null
      ? 'The active revision already matches the draft'
      : needsInstallCap && !canInstall
        ? INSTALL_REASON
        : needsLifecycleCap && !canManageLifecycle
          ? LIFECYCLE_REASON
          : null

  const runPrimary = (): void => {
    switch (primary?.action) {
      case 'activate':
      case 'review':
        // The review moment IS activation — the server enforces step-up and
        // the dialog shows the grant diff before anything changes.
        onActivate()
        return
      case 'diagnostics':
        onRunDiagnostics()
        return
      case 'open-plugins-page':
        onOpenPluginsPage()
        return
      case 'delete':
        onDelete()
        return
      case 'enable':
        onSetEnabled(true)
        return
      case null:
      case undefined:
        return
    }
  }

  const lifecycleBlockedReason = !canManageLifecycle
    ? LIFECYCLE_REASON
    : !summary?.activeVersion
      ? 'Nothing is activated yet'
      : null
  const previewBlockedReason = !summary?.hasDraftSource
    ? 'The draft source is missing'
    : !summary.hasModules
      ? 'The draft declares no module pack'
      : null

  const menuItems: SplitButtonMenuItem[] = [
    {
      id: 'preview',
      label: 'Preview in canvas',
      disabled: previewBlockedReason !== null,
      tooltip: previewBlockedReason ?? undefined,
      onSelect: onPreview,
      testId: 'ide-preview',
    },
    { id: 'diagnostics', label: 'Re-run diagnostics', onSelect: onRunDiagnostics },
    {
      id: 'rollback',
      label: 'Rollback to previous revision',
      separatorBefore: true,
      disabled: !canInstall || !summary?.activeVersion,
      tooltip: !canInstall
        ? INSTALL_REASON
        : !summary?.activeVersion
          ? 'Nothing is activated yet'
          : undefined,
      onSelect: onRollback,
    },
    {
      id: 'deactivate',
      label: 'Deactivate',
      disabled: lifecycleBlockedReason !== null || summary?.state === 'disabled',
      tooltip:
        lifecycleBlockedReason ??
        (summary?.state === 'disabled' ? 'Already deactivated' : undefined),
      onSelect: () => onSetEnabled(false),
    },
    {
      id: 'restart',
      label: 'Restart',
      disabled: lifecycleBlockedReason !== null,
      tooltip: lifecycleBlockedReason ?? undefined,
      onSelect: onRestart,
    },
    { id: 'plugins-page', label: 'Open on Plugins page', onSelect: onOpenPluginsPage },
    {
      id: 'delete',
      label: 'Delete site plugin',
      separatorBefore: true,
      danger: true,
      disabled: !canInstall,
      tooltip: !canInstall ? INSTALL_REASON : undefined,
      onSelect: onDelete,
    },
  ]

  return (
    <div className={styles.actions}>
      {uniquePeers.size > 0 && (
        <span className={styles.peerStack} aria-label={`${uniquePeers.size} other editor(s) in this IDE`}>
          {[...uniquePeers.values()].slice(0, 4).map((peer) => (
            <PeerAvatar key={peer.user.id} user={peer.user} size={18} className={styles.peerAvatar} />
          ))}
        </span>
      )}

      {state && (
        <ToolbarStatus
          label={sitePluginStateLabel(state)}
          tone={stateTone(state)}
          state={state}
          testId="ide-state-chip"
        />
      )}

      <SplitButton
        variant="primary"
        size="sm"
        label={activating && primary?.action === 'activate' ? 'Building…' : primaryLabel}
        onClick={runPrimary}
        disabled={activating || primaryBlockedReason !== null}
        busy={activating}
        primaryTooltip={primaryBlockedReason ?? undefined}
        menuItems={menuItems}
        menuTriggerLabel="More plugin actions"
        menuLabel="Site plugin actions"
        menuWidth={240}
        primaryTestId="ide-primary-action"
        menuTriggerTestId="ide-overflow"
        menuTestId="ide-actions-menu"
      />
    </div>
  )
}
