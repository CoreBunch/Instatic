/**
 * IdeActions — the IDE toolbar's right slot: peer avatar stack, runtime
 * state chip, ONE state-appropriate smart primary action, an optional
 * `Preview in canvas` secondary (module drafts), and the overflow menu.
 * Unavailable actions are disabled with an inline reason, never hidden.
 */
import { useEffect, useRef, useState } from 'react'
import {
  sitePluginPrimaryAction,
  sitePluginStateLabel,
  type SitePluginRuntimeState,
  type SitePluginSummary,
} from '@core/site-plugins'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { MoreHorizontalSolidIcon } from 'pixel-art-icons/icons/more-horizontal-solid'
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
  const [menuOpen, setMenuOpen] = useState(false)
  const overflowRef = useRef<HTMLButtonElement | null>(null)

  // The menu is not focusable and a mouse click does not leave focus on
  // the trigger (the Button's tooltip wrapper re-renders it once
  // aria-expanded flips), so put focus on the trigger after the open
  // commits: Escape then closes what the click opened.
  useEffect(() => {
    if (menuOpen) overflowRef.current?.focus()
  }, [menuOpen])

  const state = summary?.state ?? null
  const primary = state ? sitePluginPrimaryAction(state) : null

  const uniquePeers = new Map(peers.map((peer) => [peer.user.id, peer]))

  const runPrimary = (): void => {
    if (!primary) return
    switch (primary.action) {
      case 'activate':
        onActivate()
        return
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
        return
    }
  }

  // Same split as the server: install-class actions need plugins.install,
  // enable/disable/restart need plugins.lifecycle.
  const needsInstallCap =
    primary?.action === 'activate' || primary?.action === 'review' || primary?.action === 'delete'
  const needsLifecycleCap = primary?.action === 'enable'
  const primaryBlockedReason =
    needsInstallCap && !canInstall
      ? 'Requires the plugins.install permission'
      : needsLifecycleCap && !canManageLifecycle
        ? 'Requires the plugins.lifecycle permission'
        : null
  const primaryDisabled = activating || primaryBlockedReason !== null
  const lifecycleBlockedReason = !canManageLifecycle
    ? 'Requires the plugins.lifecycle permission'
    : !summary?.activeVersion
      ? 'Nothing is activated yet'
      : null

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

      {summary?.hasModules && summary.hasDraftSource && (
        <Button variant="secondary" size="sm" onClick={onPreview} data-testid="ide-preview">
          Preview in canvas
        </Button>
      )}

      {primary && primary.action !== null && (
        <Button
          variant="primary"
          size="sm"
          disabled={primaryDisabled}
          tooltip={primaryBlockedReason ?? undefined}
          onClick={runPrimary}
          data-testid="ide-primary-action"
        >
          {activating && primary.action === 'activate' ? 'Building…' : primary.label}
        </Button>
      )}

      <Button
        ref={overflowRef}
        variant="ghost"
        size="sm"
        iconOnly
        aria-label="More actions"
        tooltip="More actions"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && menuOpen) {
            event.preventDefault()
            setMenuOpen(false)
          }
        }}
        data-testid="ide-overflow"
      >
        <MoreHorizontalSolidIcon size={14} aria-hidden="true" />
      </Button>

      {menuOpen && (
        <ContextMenu
          anchorRef={overflowRef}
          ariaLabel="Site plugin actions"
          onClose={() => setMenuOpen(false)}
          minWidth={230}
        >
          <ContextMenuItem
            onClick={() => {
              onRunDiagnostics()
              setMenuOpen(false)
            }}
          >
            Re-run diagnostics
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!canInstall || !summary?.activeVersion}
            tooltip={
              !canInstall
                ? 'Requires the plugins.install permission'
                : !summary?.activeVersion
                  ? 'Nothing is activated yet'
                  : undefined
            }
            onClick={() => {
              onRollback()
              setMenuOpen(false)
            }}
          >
            Rollback to previous revision
          </ContextMenuItem>
          <ContextMenuItem
            disabled={lifecycleBlockedReason !== null || summary?.state === 'disabled'}
            tooltip={
              lifecycleBlockedReason ??
              (summary?.state === 'disabled' ? 'Already deactivated' : undefined)
            }
            onClick={() => {
              onSetEnabled(false)
              setMenuOpen(false)
            }}
          >
            Deactivate
          </ContextMenuItem>
          <ContextMenuItem
            disabled={lifecycleBlockedReason !== null}
            tooltip={lifecycleBlockedReason ?? undefined}
            onClick={() => {
              onRestart()
              setMenuOpen(false)
            }}
          >
            Restart
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              onOpenPluginsPage()
              setMenuOpen(false)
            }}
          >
            Open on Plugins page
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            danger
            disabled={!canInstall}
            tooltip={!canInstall ? 'Requires the plugins.install permission' : undefined}
            onClick={() => {
              onDelete()
              setMenuOpen(false)
            }}
          >
            Delete site plugin
          </ContextMenuItem>
        </ContextMenu>
      )}
    </div>
  )
}
