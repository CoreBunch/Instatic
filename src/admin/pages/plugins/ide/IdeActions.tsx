/**
 * IdeActions — the IDE toolbar's right slot: peer avatar stack, runtime
 * state chip, ONE state-appropriate smart primary action, an optional
 * `Preview in canvas` secondary (module drafts), and the overflow menu.
 * Unavailable actions are disabled with an inline reason, never hidden.
 */
import { useRef, useState } from 'react'
import {
  sitePluginPrimaryAction,
  sitePluginStateLabel,
  type SitePluginSummary,
} from '@core/site-plugins'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { MoreHorizontalSolidIcon } from 'pixel-art-icons/icons/more-horizontal-solid'
import { PeerAvatar } from '@site/collab/PeerAvatar'
import type { IdePeer } from './idePresence'
import styles from './IdeActions.module.css'

interface IdeActionsProps {
  summary: SitePluginSummary | null
  peers: IdePeer[]
  canInstall: boolean
  activating: boolean
  onActivate: () => void
  onPreview: () => void
  onRollback: () => void
  onSetEnabled: (enabled: boolean) => void
  onRestart: () => void
  onRerunDiagnostics: () => void
  onOpenSettings: () => void
  onDelete: () => void
  onShowDiagnostics: () => void
}

export function IdeActions({
  summary,
  peers,
  canInstall,
  activating,
  onActivate,
  onPreview,
  onRollback,
  onSetEnabled,
  onRestart,
  onRerunDiagnostics,
  onOpenSettings,
  onDelete,
  onShowDiagnostics,
}: IdeActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const overflowRef = useRef<HTMLButtonElement | null>(null)

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
        onShowDiagnostics()
        return
      case 'logs':
        onOpenSettings()
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

  const needsInstallCap = primary?.action === 'activate' || primary?.action === 'review' || primary?.action === 'enable' || primary?.action === 'delete'
  const primaryDisabled = activating || (needsInstallCap && !canInstall)

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
        <span className={styles.stateChip} data-state={state} data-testid="ide-state-chip">
          {sitePluginStateLabel(state)}
        </span>
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
          tooltip={
            needsInstallCap && !canInstall
              ? 'Requires the plugins.install permission'
              : undefined
          }
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
        onClick={() => setMenuOpen((open) => !open)}
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
            disabled={!summary?.hasModules || !summary.hasDraftSource}
            tooltip={!summary?.hasModules ? 'The draft declares no module pack' : undefined}
            onClick={() => {
              onPreview()
              setMenuOpen(false)
            }}
          >
            Preview in canvas
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              onRerunDiagnostics()
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
            disabled={!summary?.activeVersion || summary.state === 'disabled'}
            tooltip={!summary?.activeVersion ? 'Nothing is activated yet' : undefined}
            onClick={() => {
              onSetEnabled(false)
              setMenuOpen(false)
            }}
          >
            Deactivate
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!summary?.activeVersion}
            tooltip={!summary?.activeVersion ? 'Nothing is activated yet' : undefined}
            onClick={() => {
              onRestart()
              setMenuOpen(false)
            }}
          >
            Restart
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!summary?.activeVersion}
            tooltip={!summary?.activeVersion ? 'Settings exist after the first activation' : undefined}
            onClick={() => {
              onOpenSettings()
              setMenuOpen(false)
            }}
          >
            Open plugin settings
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
