/**
 * Toolbar — fixed top bar shared by every admin route.
 *
 * Layout (left → right):
 *   [Site brand] [admin nav]
 *   [Plugin buttons] [spacer→] [right slot]    [Account menu]
 *
 * Undo/Redo lives inside the canvas notch (CanvasNotch), not the toolbar —
 * those controls only operate on the visual editor's page tree, so they have
 * no meaning on admin pages outside the canvas (Content, Plugins, …).
 *
 * Composition contract:
 *   - `siteName` / `faviconUrl` are PROPS, NOT a store subscription. That
 *     keeps the toolbar usable from `AdminPageLayout` (Plugins / Users /
 *     Account / plugin admin pages) without pulling the editor store into
 *     the non-editor admin bundle.
 *   - The editor-specific overlay (preview iframe) is passed in by the canvas
 *     layout via `overlay`. AdminPageLayout passes no overlay and the toolbar
 *     shows nothing in that position.
 *   - The `rightSlot` is owned by the caller — `AdminCanvasLayout` builds
 *     zoom / publish / settings buttons; `AdminPageLayout` builds its own
 *     toolbar right slot + settings button.
 *
 * Accessibility (WCAG 2.1 AA):
 * - native <header> banner landmark for the top-level toolbar
 * - aria-label on the nav region
 * - All interactive children have 44×44px minimum touch targets
 */

import { useEffect, useState, type ReactNode } from 'react'
import { ArticleSolidIcon } from 'pixel-art-icons/icons/article-solid'
import { AiBoxSolidIcon } from 'pixel-art-icons/icons/ai-box-solid'
import { DashboardSolidIcon } from 'pixel-art-icons/icons/dashboard-solid'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import { pluginRuntime } from '@core/plugins/runtime'
import type { RegisteredPluginToolbarButton } from '@core/plugin-sdk'
import { AccountMenuButton } from '@admin/shared/AccountMenuButton'
import { OpenLivePageButton } from '@admin/shared/OpenLivePageButton'
import { Link } from '@admin/lib/routing'
import { Button } from '@ui/components/Button'
import { Skeleton } from '@ui/components/Skeleton'
import { Tooltip } from '@ui/components/Tooltip'
import { cn } from '@ui/cn'
import type { AdminWorkspace } from '@admin/workspace'
import styles from './Toolbar.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

const NAV_ICON_SIZE = 13

interface ToolbarProps {
  /** Site name shown in the brand position. Null renders the loading skeleton. */
  siteName?: string | null
  /** Optional site favicon URL. When set, renders instead of the site-name text. */
  faviconUrl?: string | null
  /** Active admin section — drives the default nav slot's highlight. */
  section?: AdminWorkspace
  /** Replaces the default admin section navigation links. */
  adminNavigationSlot?: ReactNode
  /**
   * Full-screen overlay siblings rendered before the toolbar header. Used by
   * AdminCanvasLayout to mount the preview overlay (also editor-only and
   * lazy-loaded). The overlay is a sibling rather than a child so it can
   * cover the whole viewport instead of being clipped by the toolbar's
   * stacking context.
   */
  overlay?: ReactNode
  /**
   * Content rendered immediately before the account menu. Both layouts
   * own this region: AdminCanvasLayout fills it with zoom / publish /
   * settings; AdminPageLayout passes any page-specific toolbar items
   * followed by the SettingsButton.
   */
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
  adminNavigationSlot,
  overlay,
  rightSlot,
}: ToolbarProps) {
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

  return (
    <>
      {overlay}
      <header
        aria-label="Editor toolbar"
        data-testid="toolbar"
        className={styles.header}
      >
        {/* ── Left section ────────────────────────────────────────────────── */}

        {siteName === null ? (
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
        )}
        {adminNavigationSlot ?? <DefaultAdminNavigation section={section} />}

        <div className={styles.workspaceToolbarItems}>
          {pluginButtons.map((button) => {
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
          })}

          {/* ── Spacer ──────────────────────────────────────────────────────── */}
          <div className={styles.spacer} aria-hidden="true" />

          {/* ── Right section — caller-owned ─────────────────────────────── */}
          {rightSlot}
          {/* OpenLivePageButton + AccountMenuButton are always rendered,
              regardless of `rightSlot`. The first lets every admin route
              jump to the live site in a new tab (deep-linking to the
              active page when one is open in the canvas, falling back to
              the site root elsewhere); the second is the account / sign-out
              entry point. Both are reachable from Users / Content /
              Plugins / etc. so they live in the toolbar shell, not in any
              layout's right slot. */}
          <OpenLivePageButton />
          <AccountMenuButton />
        </div>
      </header>
    </>
  )
}

function DefaultAdminNavigation({ section }: { section: AdminWorkspace }) {
  return (
    <>
      <DefaultNavSlot
        to="/admin/dashboard"
        icon={<DashboardSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
        label="Dashboard"
        active={section === 'dashboard'}
      />
      <DefaultNavSlot
        to="/admin/site"
        icon={<LayoutSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
        label="Site"
        active={section === 'site'}
      />
      <DefaultNavSlot
        to="/admin/content"
        icon={<ArticleSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
        label="Content"
        active={section === 'content'}
      />
      <DefaultNavSlot
        to="/admin/data"
        icon={<DatabaseSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
        label="Data"
        active={section === 'data'}
      />
      <DefaultNavSlot
        to="/admin/media"
        icon={<ImagesSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
        label="Media"
        active={section === 'media'}
      />
      <DefaultNavSlot
        to="/admin/plugins"
        icon={<PackageSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
        label="Plugins"
        active={section === 'plugins'}
      />
      <DefaultNavSlot
        to="/admin/ai"
        icon={<AiBoxSolidIcon size={NAV_ICON_SIZE} aria-hidden="true" />}
        label="AI"
        active={section === 'ai'}
      />
    </>
  )
}

function DefaultNavSlot({
  to,
  icon,
  label,
  active,
}: {
  to: string
  icon: ReactNode
  label: string
  active: boolean
}) {
  if (active) {
    return (
      <span className={styles.activeSection}>
        {icon}
        <span>{label}</span>
      </span>
    )
  }
  return (
    <Link className={styles.adminLink} to={to}>
      {icon}
      <span>{label}</span>
    </Link>
  )
}

export function ToolbarDivider() {
  return (
    <div
      aria-hidden="true"
      className={styles.divider}
    />
  )
}
