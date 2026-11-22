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
 * Also lists the manifest's `appScopes`: what an app a site member signed in
 * to may later be allowed to do through the plugin. Over an existing install
 * each is marked new, reworded, unchanged or removed (`diffPluginAppScopes`):
 * a member allowed a scope in the words of its description, so the server
 * withdraws the reworded and removed ones at the update, and the owner is
 * told before confirming. The "no new permissions" reassurance is withheld
 * whenever the scopes differ.
 *
 * Also displays `networkAllowedHosts` from the manifest in its own section.
 * Permissions describe broad CMS capabilities ("inject scripts"); the
 * host list describes the concrete remote origins those scripts will talk
 * to (e.g. `threejs.org`, `*.cdn.example.com`). Both dimensions are
 * security-relevant: a plugin with `frontend.assets` plus an unexpected
 * allowlist entry can exfiltrate visitor data to that host. Showing both
 * before activation is the only way the operator can make an informed
 * decision.
 *
 * `frontend.origins` gets the same treatment in a third section: each host a
 * plugin may load scripts or embed frames from on published pages is listed
 * in plain words, and an upgrade that adds one flags it as new.
 *
 * `mail.templates` is the fourth: each email the plugin can send is listed
 * with its subject and body, shown in the same script-less frame the Email
 * workspace previews with. An upgrade that adds a template or changes the
 * wording of one flags it, because approving a plugin's email is approving
 * what it says in the site's name.
 */
import { lt as semverLt } from 'semver'
import { Button } from '@ui/components/Button'
import {
  permissionDescription,
  type PluginAppScope,
  type PluginFrontendOrigins,
  type PluginMailTemplateDeclaration,
  type PluginManifest,
  type PluginPermission,
} from '@core/plugin-sdk'
import { diffPluginAppScopes, type PluginAppScopeChange, type PluginAppScopeDiffRow } from '@core/members'
import { renderMailTemplate, sampleMailVariables } from '@core/mail'
import { permissionLabel } from '@core/plugins/manifest'
import { pluginMailTemplateKey } from '@core/plugins/manifestMail'
import {
  computePermissionDiff,
  type PermissionDiffRow,
  type PermissionDiffStatus,
} from './computePermissionDiff'
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
   * The previously-installed manifest's `appScopes`. A scope the new
   * manifest removes or rewords is withdrawn at the update, so the review
   * marks each one.
   */
  previousAppScopes?: PluginAppScope[]
  /**
   * The previously-installed manifest's `frontend.origins` (when this is an
   * upgrade), so a script or frame origin the upgrade adds shows as new.
   */
  previousFrontendOrigins?: PluginFrontendOrigins
  /**
   * The previously-installed manifest's `mail.templates` (when this is an
   * upgrade), so a template the upgrade adds or rewords shows as such.
   */
  previousMailTemplates?: PluginMailTemplateDeclaration[]
}

type MailTemplateStatus = 'new' | 'changed' | 'existing'

/** How a template in the new manifest compares with the installed one's. */
function mailTemplateStatus(
  template: PluginMailTemplateDeclaration,
  previous: readonly PluginMailTemplateDeclaration[] | undefined,
): MailTemplateStatus {
  const before = previous?.find((candidate) => candidate.key === template.key)
  if (!before) return 'new'
  // Everything the owner approved: what it says, what it is called, and what
  // each variable is (a `text` variable turned `link` can carry an address).
  const approved = (declaration: PluginMailTemplateDeclaration) =>
    JSON.stringify([
      declaration.subject,
      declaration.body,
      declaration.label,
      declaration.description,
      declaration.variables.map((variable) => [variable.name, variable.kind ?? 'text']).sort(),
    ])
  return approved(before) === approved(template) ? 'existing' : 'changed'
}

const MAIL_TEMPLATE_BADGE: Record<MailTemplateStatus, string> = {
  new: 'New',
  changed: 'Changed',
  existing: 'Already approved',
}

type HostDiffStatus = 'new' | 'existing' | 'dropped'

interface HostDiffRow {
  host: string
  status: HostDiffStatus
}

function diffHostList(
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

const APP_SCOPE_BADGE: Record<PluginAppScopeChange, { label: string; className: string }> = {
  new: { label: 'New', className: styles.badgeNew },
  changed: { label: 'Reworded', className: styles.badgeNew },
  unchanged: { label: 'Unchanged', className: styles.badgeExisting },
  removed: { label: 'Removed', className: styles.badgeDropped },
}

/** The row tint the permission rows use, for an app scope's change. */
const APP_SCOPE_ROW_STATUS: Record<PluginAppScopeChange, PermissionDiffStatus> = {
  new: 'new',
  changed: 'new',
  unchanged: 'existing',
  removed: 'dropped',
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

  // App scopes are compared whenever the plugin is already installed, a
  // reinstall of the same version included: the server withdraws on what the
  // two manifests say, not on the version number.
  const comparesAppScopes = isInstalled && !isDowngrade
  const declaredAppScopes = pending.manifest.appScopes ?? []
  const appScopeRows: PluginAppScopeDiffRow[] = comparesAppScopes
    ? diffPluginAppScopes(pending.previousAppScopes ?? [], declaredAppScopes)
    : declaredAppScopes.map((scope) => ({ ...scope, status: 'new' }))
  const withdrawnAppScopeCount = comparesAppScopes
    ? appScopeRows.filter((row) => row.status === 'changed' || row.status === 'removed').length
    : 0
  const appScopesDiffer = comparesAppScopes && appScopeRows.some((row) => row.status !== 'unchanged')
  const originGroups = [
    {
      kind: 'scripts',
      phrase: 'May load scripts from',
      rows: diffHostList(
        pending.manifest.frontend?.origins?.scripts ?? [],
        pending.previousFrontendOrigins?.scripts,
        isUpgrade,
      ),
    },
    {
      kind: 'frames',
      phrase: 'May embed frames from',
      rows: diffHostList(
        pending.manifest.frontend?.origins?.frames ?? [],
        pending.previousFrontendOrigins?.frames,
        isUpgrade,
      ),
    },
  ] as const
  const mailTemplates = (pending.manifest.mail?.templates ?? []).map((template) => ({
    template,
    status: isUpgrade ? mailTemplateStatus(template, pending.previousMailTemplates) : ('new' as const),
    preview: renderMailTemplate(
      {
        key: pluginMailTemplateKey(pending.manifest.id, template.key),
        subject: template.subject,
        body: template.body,
        variables: template.variables,
      },
      { 'site.name': 'Your site', 'site.url': '', ...sampleMailVariables(template.variables) },
    ),
  }))
  const changedMailCount = isUpgrade ? mailTemplates.filter((row) => row.status !== 'existing').length : 0
  const originRowCount = originGroups.reduce((count, group) => count + group.rows.length, 0)
  const newOriginCount = isUpgrade
    ? originGroups.reduce((count, group) => count + group.rows.filter((row) => row.status === 'new').length, 0)
    : 0

  // `editor.code` means the host will dynamically import plugin JavaScript
  // into the admin window — unsandboxed, with full admin-session privileges.
  // That deserves its own unmissable callout on top of the permission row.
  const runsUnsandboxedCode = pending.manifest.permissions.includes('editor.code')
  const hasAppPages = pending.manifest.adminPages.some((page) => page.content.kind === 'app')
  const hasEditorEntrypoint = Boolean(pending.manifest.entrypoints?.editor)

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

      {withdrawnAppScopeCount > 0 && (
        <div className={styles.alert} role="alert" data-testid="app-scope-diff-alert">
          This {isReinstall ? 'reinstall' : 'update'} rewords or removes{' '}
          <strong>
            {withdrawnAppScopeCount} thing{withdrawnAppScopeCount === 1 ? '' : 's'} apps were allowed to do
          </strong>{' '}
          through the plugin. Members who allowed an app one of them are signed out of that app and will be
          asked again, and it is taken off your registered apps until you give it back under Users, Site
          members, Apps.
        </div>
      )}

      {isUpgrade && newCount === 0 && rows.length > 0 && !appScopesDiffer && (
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

      {(() => {
        const hostRows = diffHostList(
          pending.manifest.networkAllowedHosts ?? [],
          pending.previousNetworkAllowedHosts,
          isUpgrade,
        )
        if (hostRows.length === 0) return null
        return (
          <div
            className={styles.networkSection}
            data-testid="permission-review-network-hosts"
          >
            <div className={styles.networkHeader}>
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
        )
      })()}

      {appScopeRows.length > 0 && (
        <div className={styles.networkSection} data-testid="permission-review-app-scopes">
          <div className={styles.networkHeader}>
            <strong>Access for apps</strong>
            <span className={styles.description}>
              An app a site member signs in to can be allowed to do these through the plugin. Nothing is
              allowed until you give it to an app under Users, Site members, Apps, and the member agrees.
            </span>
          </div>
          <ul className={styles.list}>
            {appScopeRows.map((scope) => (
              <li
                key={scope.name}
                className={styles.row}
                data-status={APP_SCOPE_ROW_STATUS[scope.status]}
                data-app-scope={scope.name}
                data-app-scope-status={scope.status}
              >
                <div className={styles.label}>
                  <span>{scope.description}</span>
                  {comparesAppScopes && (
                    <span className={`${styles.badge} ${APP_SCOPE_BADGE[scope.status].className}`}>
                      {APP_SCOPE_BADGE[scope.status].label}
                    </span>
                  )}
                </div>
                {scope.was !== undefined && (
                  <span className={styles.description}>Members allowed it as: {scope.was}</span>
                )}
                <span className={styles.description}>
                  <code>{`plugin:${pending.manifest.id}:${scope.name}`}</code>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {originRowCount > 0 && (
        <div
          className={styles.networkSection}
          data-testid="permission-review-frontend-origins"
        >
          <div className={styles.networkHeader}>
            <strong>Third-party code on published pages</strong>
            <span className={styles.description}>
              Visitors' browsers may load code or frames from these hosts on
              your published pages. Other hosts stay blocked.
            </span>
          </div>
          {isUpgrade && newOriginCount > 0 && (
            <div className={styles.alert} role="alert" data-testid="frontend-origins-diff-alert">
              This update adds <strong>{newOriginCount} new third-party host{newOriginCount === 1 ? '' : 's'}</strong> on
              published pages.
            </div>
          )}
          <ul className={styles.list}>
            {originGroups.flatMap((group) =>
              group.rows.map((row) => (
                <li
                  key={`${group.kind}:${row.host}:${row.status}`}
                  className={styles.row}
                  data-status={row.status}
                  data-frontend-origin={row.host}
                  data-frontend-origin-kind={group.kind}
                >
                  <div className={styles.label}>
                    <span>
                      {group.phrase} <code>{row.host}</code>
                    </span>
                    {isUpgrade && (
                      <span className={`${styles.badge} ${statusBadgeClass(row.status)}`}>
                        {statusBadgeLabel(row.status)}
                      </span>
                    )}
                  </div>
                  {row.host.startsWith('*.') && row.status !== 'dropped' && (
                    <span className={styles.wildcardWarning} data-testid="frontend-origin-wildcard-warning">
                      Any subdomain of <code>{row.host.slice(2)}</code>, not one host. Approve it only if a
                      single company controls every subdomain there.
                    </span>
                  )}
                </li>
              )),
            )}
          </ul>
        </div>
      )}

      {mailTemplates.length > 0 && (
        <div className={styles.networkSection} data-testid="permission-review-mail-templates">
          <div className={styles.networkHeader}>
            <strong>
              Adds {mailTemplates.length} email template{mailTemplates.length === 1 ? '' : 's'}
            </strong>
            <span className={styles.description}>
              These are the only emails the plugin can send. They are sent from your site's address, and you
              can reword each one under Email → Templates.
            </span>
          </div>
          {changedMailCount > 0 && (
            <div className={styles.alert} role="alert" data-testid="mail-templates-diff-alert">
              <span>
                This update adds or changes{' '}
                <strong>{changedMailCount} email template{changedMailCount === 1 ? '' : 's'}</strong>. Read the
                highlighted ones before continuing.
              </span>
            </div>
          )}
          <ul className={styles.list}>
            {mailTemplates.map(({ template, status, preview }) => (
              <li
                key={template.key}
                className={styles.row}
                data-mail-template={template.key}
                data-status={status === 'existing' ? 'existing' : isUpgrade ? 'new' : undefined}
                data-mail-status={status}
              >
                <div className={styles.label}>
                  <span>{template.label}</span>
                  {isUpgrade && (
                    <span className={`${styles.badge} ${status === 'existing' ? styles.badgeExisting : styles.badgeNew}`}>
                      {MAIL_TEMPLATE_BADGE[status]}
                    </span>
                  )}
                </div>
                <span className={styles.description}>{template.description}</span>
                <details className={styles.mailPreview} open={isUpgrade && status !== 'existing'}>
                  <summary>Read the email</summary>
                  <p className={styles.mailSubject}>{preview.subject}</p>
                  <iframe
                    className={styles.mailBody}
                    title={`${template.label} email`}
                    sandbox=""
                    srcDoc={preview.html}
                  />
                </details>
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
                    ? newCount > 0 || changedMailCount > 0
                      ? `Approve ${newCount + changedMailCount} new and update to ${pending.manifest.version}`
                      : `Update to ${pending.manifest.version}`
                    : 'Approve and Install'}
          </span>
        </Button>
      </div>
    </section>
  )
}
