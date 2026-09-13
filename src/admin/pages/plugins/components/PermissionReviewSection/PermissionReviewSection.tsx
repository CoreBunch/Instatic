/**
 * PermissionReviewSection — pre-install / pre-upgrade permission consent UI.
 *
 * For a fresh install: lists every requested permission with its label
 * and description.
 *
 * For an upgrade: computes the diff against the previously-granted set
 * and renders three status classes:
 *
 *   • new      — listed first with a "NEW" badge + warning tint. These
 *                are the permissions a malicious upgrade would slip in
 *                without notice if we silently re-approved everything.
 *                The user MUST see and consciously approve them.
 *   • existing — already approved on the prior install. Shown for full
 *                context but visually de-emphasised.
 *   • dropped  — previously granted but not requested by the new manifest;
 *                the host will auto-revoke them. Shown as informational.
 *
 * If the upgrade adds zero new permissions, we render a quick reassurance
 * banner ("No new permissions in this update") so the user can confirm
 * with confidence.
 *
 * Also displays the manifest's two allowlists, each in its own section:
 *
 *   • `networkAllowedHosts` — the concrete remote origins the plugin's
 *     code will talk to (e.g. `threejs.org`, `*.cdn.example.com`).
 *   • `contentAccess` — the CMS tables whose entries the plugin can touch,
 *     with per-table modes. The `@own-created` marker renders as the
 *     human-readable "Tables this plugin creates".
 *
 * Permissions describe broad CMS capabilities ("inject scripts", "write
 * content"); the allowlists describe the concrete origins and tables those
 * capabilities apply to. All three dimensions are security-relevant: a
 * plugin with `frontend.assets` plus an unexpected host entry can
 * exfiltrate visitor data, and an upgrade adding `write` mode on an
 * already-approved table is a silent privilege expansion. Each section
 * diffs new/existing/dropped rows on upgrade so nothing slips in
 * unreviewed.
 */
import { lt as semverLt } from 'semver'
import { Button } from '@ui/components/Button'
import {
  permissionDescription,
  type ContentAccessEntry,
  type ContentAccessMode,
  type PluginManifest,
  type PluginPermission,
} from '@core/plugin-sdk'
import { permissionLabel } from '@core/plugins/manifest'
import {
  computePermissionDiff,
  type PermissionDiffRow,
  type PermissionDiffStatus,
} from './computePermissionDiff'
import {
  computeContentAccessDiff,
  isOwnCreatedContentTable,
} from './computeContentAccessDiff'
import styles from './PermissionReviewSection.module.css'

interface PermissionReviewPending {
  manifest: PluginManifest
  upgradeFromVersion?: string
  previouslyGrantedPermissions?: PluginPermission[]
  /**
   * The previously-installed manifest's `networkAllowedHosts` (when this is
   * an upgrade). Used to flag hosts the upgrade adds compared to what the
   * operator already approved — a moved-or-added external dependency is
   * exactly the kind of supply-chain attack the consent screen should catch.
   */
  previousNetworkAllowedHosts?: string[]
  /**
   * The previously-installed manifest's `contentAccess` allowlist (when this
   * is an upgrade). Used to flag tables — and modes on already-approved
   * tables — that the upgrade adds, the same way hosts are diffed above.
   */
  previousContentAccess?: ContentAccessEntry[]
}

type HostDiffStatus = 'new' | 'existing' | 'dropped'

interface HostDiffRow {
  host: string
  status: HostDiffStatus
}

function diffNetworkAllowedHosts(
  next: readonly string[],
  previous: readonly string[] | undefined,
  isUpgrade: boolean,
): HostDiffRow[] {
  const previousSet = new Set(previous ?? [])
  const nextSet = new Set(next)
  const rows: HostDiffRow[] = []
  for (const host of next) {
    const status: HostDiffStatus = !isUpgrade || !previousSet.has(host) ? 'new' : 'existing'
    rows.push({ host, status })
  }
  if (isUpgrade) {
    for (const host of previous ?? []) {
      if (!nextSet.has(host)) rows.push({ host, status: 'dropped' })
    }
  }
  // Sort: new first, then existing, then dropped — same order the
  // permission diff list uses for consistency.
  const order: Record<HostDiffStatus, number> = { new: 0, existing: 1, dropped: 2 }
  return rows.sort((a, b) => order[a.status] - order[b.status] || a.host.localeCompare(b.host))
}

interface PermissionReviewSectionProps {
  pending: PermissionReviewPending
  uploading: boolean
  onCancel: () => void
  onConfirm: () => void
}

function statusBadgeClass(status: PermissionDiffStatus): string {
  if (status === 'new') return styles.badgeNew
  if (status === 'existing') return styles.badgeExisting
  return styles.badgeDropped
}

function statusBadgeLabel(status: PermissionDiffStatus): string {
  if (status === 'new') return 'New'
  if (status === 'existing') return 'Already approved'
  return 'No longer requested'
}

/** "read, write" → "Read, write" — modes stay lowercase manifest literals. */
function formatContentAccessModes(modes: readonly ContentAccessMode[]): string {
  const joined = modes.join(', ')
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

export function PermissionReviewSection({
  pending,
  uploading,
  onCancel,
  onConfirm,
}: PermissionReviewSectionProps) {
  // Three cases, not two. `upgradeFromVersion` is now set whenever the plugin
  // is already installed, so compare it to tell an upgrade from a reinstall of
  // the same build — and from a downgrade, which the server refuses outright
  // (install.ts) and which used to be described here as an update that would
  // migrate and re-activate.
  const installedVersion = pending.upgradeFromVersion
  const isInstalled = Boolean(installedVersion)
  const isReinstall = isInstalled && installedVersion === pending.manifest.version
  const isDowngrade =
    isInstalled && !isReinstall && semverLt(pending.manifest.version, installedVersion!)
  const isUpgrade = isInstalled && !isReinstall && !isDowngrade
  const rows: PermissionDiffRow[] = isInstalled
    ? computePermissionDiff(
        pending.manifest.permissions,
        pending.previouslyGrantedPermissions,
      )
    : pending.manifest.permissions.map<PermissionDiffRow>((permission) => ({
        permission,
        // For fresh installs we still annotate "new" so the row styling
        // shows up consistently — but don't show the "Already approved"
        // / "No longer requested" branches that don't apply.
        status: 'new',
      }))

  const newCount = rows.filter((row) => row.status === 'new').length

  // `editor.code` means the host will dynamically import plugin JavaScript
  // into the admin window — unsandboxed, with full admin-session privileges.
  // That deserves its own unmissable callout on top of the permission row.
  const runsUnsandboxedCode = pending.manifest.permissions.includes('editor.code')
  const hasAppPages = pending.manifest.adminPages.some((page) => page.content.kind === 'app')
  const hasEditorEntrypoint = Boolean(pending.manifest.entrypoints?.editor)

  const contentAccessRows = computeContentAccessDiff(
    pending.manifest.contentAccess ?? [],
    pending.previousContentAccess,
    isUpgrade,
  )
  const hostRows = diffNetworkAllowedHosts(
    pending.manifest.networkAllowedHosts ?? [],
    pending.previousNetworkAllowedHosts,
    isUpgrade,
  )

  return (
    <section
      className={styles.review}
      aria-labelledby="plugin-permissions-title"
    >
      <div>
        <h2 id="plugin-permissions-title">
          {isReinstall
            ? `Reinstall ${pending.manifest.name}`
            : isDowngrade
              ? `Cannot downgrade ${pending.manifest.name}`
              : isUpgrade
                ? `Update ${pending.manifest.name}`
                : `Review ${pending.manifest.name}`}
        </h2>
        <p>
          {isReinstall
            ? `Version ${pending.manifest.version} is already installed. Reinstalling replaces its files in place and re-runs the plugin's lifecycle; settings and stored data are preserved.`
            : isDowngrade
              ? `${pending.manifest.name} is installed at ${installedVersion}. Downgrades are refused — uninstall it first if you need to go back to ${pending.manifest.version}.`
              : isUpgrade
                ? `Updating from ${installedVersion} to ${pending.manifest.version}. Existing settings and stored data are preserved; the plugin runs its migrate hook before re-activating.`
                : rows.length > 0
                  ? `${pending.manifest.name} requests access before activation.`
                  : `${pending.manifest.name} is ready to install.`}
        </p>
      </div>

      {runsUnsandboxedCode && (
        <div
          className={`${styles.alert} ${styles.alertDanger}`}
          role="alert"
          data-testid="unsandboxed-code-alert"
        >
          <span>
            This plugin runs its own JavaScript <strong>directly in the admin
            window, outside the plugin sandbox</strong>
            {hasEditorEntrypoint && hasAppPages
              ? ' (an editor entrypoint and admin app pages)'
              : hasAppPages
                ? ' (admin app pages)'
                : ' (an editor entrypoint)'}
            . That code has the same access as the admin UI itself — your
            admin session, every admin API, and this browser tab. Only
            continue if you trust the plugin author.
          </span>
        </div>
      )}

      {isUpgrade && newCount > 0 && (
        <div className={styles.alert} role="alert" data-testid="permission-diff-alert">
          This update requests <strong>{newCount} new permission{newCount === 1 ? '' : 's'}</strong>.
          Review the highlighted rows below before continuing.
        </div>
      )}

      {isUpgrade && newCount === 0 && rows.length > 0 && (
        <div className={styles.alert} role="status" data-testid="permission-diff-noop">
          No new permissions in this update.
        </div>
      )}

      {rows.length === 0 && (
        <div className={styles.empty} role="status" data-testid="permission-review-empty">
          No permissions requested — this plugin is purely declarative and
          gets no access to CMS data, editor state, or the network.
        </div>
      )}

      {rows.length > 0 && (
        <ul className={styles.list}>
          {rows.map((row) => (
            <li
              key={`${row.permission}:${row.status}`}
              className={styles.row}
              data-status={row.status}
              data-permission={row.permission}
            >
              <div className={styles.label}>
                <strong>{permissionLabel(row.permission)}</strong>
                {isUpgrade && (
                  <span className={`${styles.badge} ${statusBadgeClass(row.status)}`}>
                    {statusBadgeLabel(row.status)}
                  </span>
                )}
              </div>
              <span className={styles.description}>
                {permissionDescription(row.permission)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {contentAccessRows.length > 0 && (
        <div
          className={styles.allowlistSection}
          data-testid="permission-review-content-tables"
        >
          <div className={styles.allowlistHeader}>
            <strong>Content tables</strong>
            <span className={styles.description}>
              The plugin's access to CMS content is limited to these tables
              and modes. Tables not listed here are blocked.
            </span>
          </div>
          <ul className={styles.list}>
            {contentAccessRows.map((row) => (
              <li
                key={`${row.table}:${row.status}`}
                className={styles.row}
                data-status={row.status}
                data-content-table={row.table}
              >
                <div className={styles.label}>
                  {isOwnCreatedContentTable(row.table) ? (
                    <strong>Tables this plugin creates</strong>
                  ) : (
                    <code>{row.table}</code>
                  )}
                  {isUpgrade && (
                    <span className={`${styles.badge} ${statusBadgeClass(row.status)}`}>
                      {statusBadgeLabel(row.status)}
                    </span>
                  )}
                </div>
                <span className={styles.description}>
                  {formatContentAccessModes(row.modes)}
                  {isUpgrade && row.addedModes.length > 0 && (
                    <> — newly requested: {row.addedModes.join(', ')}</>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hostRows.length > 0 && (
        <div
          className={styles.allowlistSection}
          data-testid="permission-review-network-hosts"
        >
          <div className={styles.allowlistHeader}>
            <strong>External hosts</strong>
            <span className={styles.description}>
              The plugin will connect to these hosts from the server and
              from published pages. Hosts not listed here are blocked.
            </span>
          </div>
          <ul className={styles.list}>
            {hostRows.map((row) => (
              <li
                key={`${row.host}:${row.status}`}
                className={styles.row}
                data-status={row.status}
                data-network-host={row.host}
              >
                <div className={styles.label}>
                  <code>{row.host}</code>
                  {isUpgrade && (
                    <span className={`${styles.badge} ${statusBadgeClass(row.status)}`}>
                      {statusBadgeLabel(row.status)}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          onClick={onCancel}
        >
          <span>Cancel</span>
        </Button>
        <Button
          variant="primary"
          size="sm"
          // A downgrade is refused by the server before anything is written,
          // so offering the button only buys the operator a round trip and an
          // error banner.
          disabled={uploading || isDowngrade}
          onClick={onConfirm}
        >
          <span>
            {uploading
              ? isReinstall
                ? 'Reinstalling'
                : isUpgrade
                  ? 'Updating'
                  : 'Installing'
              : isDowngrade
                ? 'Downgrade not allowed'
                : isReinstall
                  ? `Reinstall ${pending.manifest.version}`
                  : isUpgrade
                    ? newCount > 0
                      ? `Approve ${newCount} new and update to ${pending.manifest.version}`
                      : `Update to ${pending.manifest.version}`
                    : 'Approve and Install'}
          </span>
        </Button>
      </div>
    </section>
  )
}
