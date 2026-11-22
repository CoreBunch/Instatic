/**
 * Toolbar — fixed top bar shared by every admin route.
 *
 * Desktop shows the brand, branch chip, workspace links and global actions.
 * On phones the workspace switcher owns the secondary controls inside a sheet.
 * Layouts supply editor-specific overlays and right-slot actions (e.g. Publish)
 * to keep the editor store out of the other workspaces.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { useMobileViewport } from '@admin/lib/mobileViewport'
import { pluginRuntime } from '@core/plugins/runtime'
import type { RegisteredPluginToolbarButton } from '@core/plugin-sdk'
import { AccountMenuButton } from '@admin/shared/AccountMenuButton'
import { BranchChip, BranchContextStrip } from '@admin/shared/BranchSwitcher'
import { OpenLivePageButton } from '@admin/shared/OpenLivePageButton'
import { SettingsButton } from './SettingsButton'
import { AdminSectionNavigation } from '@admin/shared/AdminSectionNavigation'
import { Button } from '@ui/components/Button'
import { Skeleton } from '@ui/components/Skeleton'
import { Tooltip } from '@ui/components/Tooltip'
import { cn } from '@ui/cn'
import type { AdminWorkspace } from '@admin/workspace'
import styles from './Toolbar.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

interface ToolbarProps {
  /** Site name shown in the brand position. Null renders the loading skeleton. */
  siteName?: string | null
  /** Optional site favicon URL. When set, renders instead of the site-name text. */
  faviconUrl?: string | null
  /** Active admin section for the navigation row and mobile switcher. */
  section?: AdminWorkspace
  onWorkspaceNavigateStart?: () => unknown
  /**
   * Full-screen overlay siblings rendered before the toolbar header. Used by
   * AdminCanvasLayout to mount the preview overlay (also editor-only and
   * lazy-loaded). The overlay is a sibling rather than a child so it can
   * cover the whole viewport instead of being clipped by the toolbar's
   * stacking context.
   */
  overlay?: ReactNode
  /** Actions specific to this workspace, such as Publish or Uploads. */
  rightSlot?: ReactNode
}

type PluginButtonStatus = {
  state: 'running' | 'success' | 'error'
  message: string
}

function pluginButtonKey(button: RegisteredPluginToolbarButton): string {
  return `${button.pluginId}:${button.id}`
}

export function Toolbar({
  siteName = null,
  faviconUrl = null,
  section = 'site',
  onWorkspaceNavigateStart,
  overlay,
  rightSlot,
}: ToolbarProps) {
  const mobile = useMobileViewport()
  const [pluginButtons, setPluginButtons] = useState<RegisteredPluginToolbarButton[]>(() =>
    pluginRuntime.getToolbarButtons(),
  )
  const [pluginStatuses, setPluginStatuses] = useState<Record<string, PluginButtonStatus>>({})
  const [statusTimers] = useState(() => new Map<string, ReturnType<typeof setTimeout>>())
  const configuredFaviconUrl = faviconUrl?.trim()

  useEffect(() => {
    return pluginRuntime.subscribe(() => {
      setPluginButtons(pluginRuntime.getToolbarButtons())
    })
  }, [])

  useEffect(() => {
    return () => {
      for (const timer of statusTimers.values()) clearTimeout(timer)
      statusTimers.clear()
    }
  }, [statusTimers])

  function setPluginStatus(key: string, status: PluginButtonStatus): void {
    const currentTimer = statusTimers.get(key)
    if (currentTimer) {
      clearTimeout(currentTimer)
      statusTimers.delete(key)
    }

    setPluginStatuses((current) => ({ ...current, [key]: status }))

    if (status.state !== 'running') {
      const timer = setTimeout(() => {
        setPluginStatuses((current) => {
          const next = { ...current }
          delete next[key]
          return next
        })
        statusTimers.delete(key)
      }, 4000)
      statusTimers.set(key, timer)
    }
  }

  async function runPluginButtonCommand(button: RegisteredPluginToolbarButton): Promise<void> {
    const key = pluginButtonKey(button)
    setPluginStatus(key, {
      state: 'running',
      message: `${button.label} running`,
    })

    try {
      const result = await pluginRuntime.runCommand(button.command)
      setPluginStatus(key, {
        state: 'success',
        message: result && typeof result === 'object' && result.message
          ? result.message
          : `${button.label} complete`,
      })
    } catch (err) {
      console.error('[plugin-runtime] command failed:', err)
      setPluginStatus(key, {
        state: 'error',
        message: getErrorMessage(err, `${button.label} failed`),
      })
    }
  }

  const pluginActions = pluginButtons.map((button) => {
    const key = pluginButtonKey(button)
    const status = pluginStatuses[key]
    const statusId = `plugin-command-status-${button.pluginId}-${button.id}`
    return (
      <div key={key} className={styles.pluginButtonWrapper}>
        <Button
          variant="secondary"
          size="sm"
          className={styles.pluginButton}
          aria-describedby={status ? statusId : undefined}
          data-state={status?.state}
          disabled={status?.state === 'running'}
          onClick={() => {
            void runPluginButtonCommand(button)
          }}
        >
          <span>{status?.state === 'running' ? `${button.label}...` : button.label}</span>
        </Button>
        {status && (
          <output
            id={statusId}
            aria-live="polite"
            className={cn(
              styles.pluginToast,
              status.state === 'error' && styles.pluginToastError,
            )}
          >
            {status.message}
          </output>
        )}
      </div>
    )
  })

  return (
    <>
      {overlay}
      <BranchContextStrip mobile={mobile} />
      <header
        aria-label="Editor toolbar"
        data-testid="toolbar"
        className={styles.header}
      >
        {/* ── Left section ────────────────────────────────────────────────── */}

        {!mobile && (siteName === null ? (
          <span
            className={styles.siteNameSkeleton}
            data-testid="toolbar-site-brand"
            aria-hidden="true"
          >
            <Skeleton width={76} height={12} radius={999} />
          </span>
        ) : configuredFaviconUrl ? (
          <Tooltip content={siteName} side="bottom">
            <img
              className={styles.siteFavicon}
              data-testid="toolbar-site-brand"
              src={configuredFaviconUrl}
              alt={`Site: ${siteName}`}
              draggable={false}
            />
          </Tooltip>
        ) : (
          <Tooltip content={siteName} side="bottom">
            <span
              className={styles.siteName}
              data-testid="toolbar-site-brand"
              aria-label={`Site: ${siteName}`}
            >
              {siteName}
            </span>
          </Tooltip>
        ))}
        {!mobile && <BranchChip />}
        <AdminSectionNavigation
          section={section}
          onWorkspaceNavigateStart={onWorkspaceNavigateStart}
          mobile={mobile ? { siteName, pluginActions } : undefined}
        />

        <div className={styles.workspaceToolbarItems}>
          {!mobile && pluginActions}
          {/* ── Spacer ──────────────────────────────────────────────────────── */}
          <div className={styles.spacer} aria-hidden="true" />

          {/* ── Right section — caller-owned ─────────────────────────────── */}
          {rightSlot}
          {!mobile && (
            <>
              <SettingsButton />
              <OpenLivePageButton />
              <AccountMenuButton />
            </>
          )}
        </div>
      </header>
    </>
  )
}
