import { getActiveAdminLocale } from "@admin/i18n"
/**
 * `PluginCard` — a single row in the installed-plugins list on the
 * Plugins admin page. Renders the plugin's identity (icon, name, version,
 * status), its action row (Settings, Schedules, Re-sync pack, Restart,
 * Enable/Disable, Remove), and its body (description, attribution links,
 * error message, crash log).
 *
 * All actions are delegated to the parent page via callbacks — the card
 * does not own any of the lifecycle state itself. The parent is the one
 * place that runs step-up auth, hits the server, and updates the plugins
 * payload; the card just shows the result and reports button clicks.
 */
import { Link } from '@admin/lib/routing'
import { Button } from '@ui/components/Button'
import { Skeleton } from '@ui/components/Skeleton'
import { PowerIcon } from 'pixel-art-icons/icons/power'
import { PowerOffIcon } from 'pixel-art-icons/icons/power-off'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import type { InstalledPlugin } from '@core/plugin-sdk'
import { safeUrl } from '@core/plugin-sdk'
import styles from './PluginCard.module.css'

interface PluginStatusBadge {
  label: string
  status: string
}

/**
 * Resolve the badge text + data attribute for a plugin's current state.
 * Active and disabled are derived from `enabled`; `error` and `installed`
 * come straight from the host's `lifecycleStatus`.
 */
function pluginStatus(plugin: InstalledPlugin): PluginStatusBadge {
  const status = plugin.lifecycleStatus ?? (plugin.enabled ? 'active' : 'disabled')
  if (status === 'error') return { label: 'Error', status }
  if (status === 'installed') return { label: 'Installed', status }
  if (status === 'disabled' || !plugin.enabled) return { label: 'Disabled', status: 'disabled' }
  return { label: 'Active', status: 'active' }
}

/**
 * Skeleton-only invocation: `<PluginCard loading />`. Renders the same
 * card chrome (background, padding, radius) with a universal three-bar
 * skeleton body. Callers that show a list of cards while the payload
 * loads just render N skeleton cards — no mock data, no bespoke
 * skeleton markup, no separate `PluginCardSkeleton` component to
 * maintain.
 */
interface PluginCardLoadingProps {
  loading: true
  plugin?: never
  busy?: never
  editorActivationError?: never
  onOpenSettings?: never
  onOpenSchedules?: never
  onInstallPack?: never
  onRestart?: never
  onReinstall?: never
  onToggle?: never
  onRemove?: never
  canConfigure?: never
  canInstall?: never
  canManageLifecycle?: never
}

interface PluginCardDataProps {
  loading?: false
  plugin: InstalledPlugin
  /**
   * Disables every action button on this card while a lifecycle request
   * is in flight (toggle/restart/install-pack/remove). The parent sets
   * this to `true` for whichever plugin id is currently busy.
   */
  busy: boolean
  /**
   * Editor-side activation failure surfaced alongside the server-side
   * `plugin.lastError`. The two have different origins (server vs.
   * editor canvas) so they're rendered as separate lines.
   */
  editorActivationError?: string
  canConfigure: boolean
  canInstall: boolean
  canManageLifecycle: boolean
  onOpenSettings: (plugin: InstalledPlugin) => void
  onOpenSchedules: (plugin: InstalledPlugin) => void
  onInstallPack: (plugin: InstalledPlugin) => void
  onRestart: (plugin: InstalledPlugin) => void
  onReinstall: () => void
  onToggle: (plugin: InstalledPlugin) => void
  onRemove: (plugin: InstalledPlugin) => void
}

type PluginCardProps = PluginCardLoadingProps | PluginCardDataProps

export function PluginCard(props: PluginCardProps) {
  if (props.loading) {
    // Skeleton mirrors the real card layout 1:1 so the swap is silent:
    //   - 36 × 36 icon block (same dimensions as `.pluginIcon`)
    //   - title row: name pill + version pill + status pill
    //   - description line below the header
    //   - right-aligned action button placeholders
    return (
      <article
        className={styles.pluginCard}
        aria-busy="true"
        aria-label="Loading plugin"
      >
        <header className={styles.pluginHeader}>
          <div className={styles.pluginHeaderInfo}>
            <Skeleton width={36} height={36} radius={8} />
            <div className={styles.pluginHeaderTitle}>
              <Skeleton width={140} height={18} />
              <Skeleton width={48} height={18} radius={999} />
              <Skeleton width={56} height={18} radius={999} />
            </div>
          </div>
          <div className={styles.pluginActions}>
            <Skeleton width={72} height={28} radius={6} />
            <Skeleton width={72} height={28} radius={6} />
          </div>
        </header>
        <div className={styles.pluginBody}>
          <Skeleton width="78%" height={12} />
        </div>
      </article>
    )
  }
  const {
    plugin,
    busy,
    editorActivationError,
    canConfigure,
    canInstall,
    canManageLifecycle,
    onOpenSettings,
    onOpenSchedules,
    onInstallPack,
    onRestart,
    onReinstall,
    onToggle,
    onRemove,
  } = props
  const status = pluginStatus(plugin)
  const iconSrc =
    plugin.manifest.icon && plugin.manifest.assetBasePath
      ? `${plugin.manifest.assetBasePath.replace(/\/+$/, '')}/${plugin.manifest.icon}`
      : null
  const { author, homepage, repository, license } = plugin.manifest
  const hasLinksRow =
    Boolean(author || homepage || repository || license) ||
    plugin.manifest.adminPages.length > 0

  return (
    <article className={styles.pluginCard}>
      <header className={styles.pluginHeader}>
        <div className={styles.pluginHeaderInfo}>
          {iconSrc && (
            <img
              src={iconSrc}
              alt=""
              className={styles.pluginIcon}
              width={36}
              height={36}
              loading="lazy"
            />
          )}
          <div className={styles.pluginHeaderTitle}>
            <h2>{plugin.name}</h2>
            <span
              className={styles.pluginVersionPill}
              aria-label={`Version ${plugin.version}`}
            >
              v{plugin.version}
            </span>
            <span className={styles.pluginStatusPill} data-status={status.status}>
              {status.label}
            </span>
          </div>
        </div>

        <div className={styles.pluginActions}>
          {canConfigure && status.status !== 'error' && plugin.manifest.settings && plugin.manifest.settings.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => onOpenSettings(plugin)}
              aria-label={`Edit settings for ${plugin.name}`}
            >
              <span>Settings</span>
            </Button>
          )}
          {status.status !== 'error' && plugin.grantedPermissions.includes('cms.schedule') && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => onOpenSchedules(plugin)}
              aria-label={`View schedules for ${plugin.name}`}
            >
              <span>Schedules</span>
            </Button>
          )}
          {canInstall &&
            status.status !== 'error' &&
            plugin.manifest.pack &&
            plugin.grantedPermissions.includes('visualComponents.register') &&
            // Re-syncing a disabled plugin's pack would inject
            // its VCs / pages / classes into the user's site —
            // the opposite of what "disabled" should mean.
            // Hide the button and gate the server endpoint
            // (server returns 400 if called directly on a
            // disabled plugin).
            plugin.enabled && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => onInstallPack(plugin)}
                aria-label={`Re-sync ${plugin.name} pack from the plugin's latest version`}
              >
                <span>Re-sync pack</span>
              </Button>
            )}
          {canInstall && status.status === 'error' && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={onReinstall}
              aria-label={`Reinstall ${plugin.name} — upload a new version to replace the broken install`}
            >
              <UploadIcon size={14} aria-hidden="true" />
              <span>Reinstall</span>
            </Button>
          )}
          {canManageLifecycle && plugin.enabled && status.status === 'error' && (
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => onRestart(plugin)}
              aria-label={`Restart ${plugin.name}`}
            >
              <ReloadIcon size={14} aria-hidden="true" />
              <span>Restart</span>
            </Button>
          )}
          {canManageLifecycle && status.status !== 'error' && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => onToggle(plugin)}
              aria-label={`${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`}
            >
              {plugin.enabled ? (
                <PowerOffIcon size={14} aria-hidden="true" />
              ) : (
                <PowerIcon size={14} aria-hidden="true" />
              )}
              <span>{plugin.enabled ? 'Disable' : 'Enable'}</span>
            </Button>
          )}
          {canInstall && (
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => onRemove(plugin)}
              aria-label={`Remove ${plugin.name}`}
            >
              <TrashSolidIcon size={14} aria-hidden="true" />
              <span>Remove</span>
            </Button>
          )}
        </div>
      </header>

      <div className={styles.pluginBody}>
        <p className={styles.pluginDescription}>
          {plugin.manifest.description ?? `${plugin.id} v${plugin.version}`}
        </p>
        {hasLinksRow && (
          <div className={styles.pluginLinksRow}>
            <div className={styles.pluginLinksLeft}>
              {license && (
                <span className={styles.pluginAttributionItem}>
                  <span className={styles.pluginLicenseBadge}>{license}</span>
                </span>
              )}
              {homepage && (
                <a
                  className={styles.pluginAttributionItem}
                  href={safeUrl(homepage)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Homepage
                </a>
              )}
              {repository && (
                <a
                  className={styles.pluginAttributionItem}
                  href={safeUrl(repository)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Source
                </a>
              )}
              {plugin.manifest.adminPages.map((page) => (
                <Link
                  key={page.id}
                  className={styles.pluginPageLink}
                  to={page.route ?? `/admin/plugins/${plugin.id}/${page.id}`}
                >
                  {page.navLabel ?? page.title}
                </Link>
              ))}
            </div>
            {author && (
              <span className={styles.pluginAuthor}>
                by{' '}
                {author.url ? (
                  <a
                    href={safeUrl(author.url)}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {author.name}
                  </a>
                ) : (
                  author.name
                )}
              </span>
            )}
          </div>
        )}
        {plugin.lastError && <p className={styles.pluginError}>{plugin.lastError}</p>}
        {editorActivationError && (
          <p className={styles.pluginError}>Editor: {editorActivationError}</p>
        )}
        {plugin.recentCrashes && plugin.recentCrashes.length > 0 && (
          <details className={styles.pluginCrashLog}>
            <summary>Recent issues ({plugin.recentCrashes.length})</summary>
            <ul>
              {plugin.recentCrashes.map((crash) => (
                <li key={crash.id}>
                  <time dateTime={crash.occurredAt}>
                    {new Date(crash.occurredAt).toLocaleString(getActiveAdminLocale())}
                  </time>
                  <span> — {crash.reason}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </article>
  )
}
