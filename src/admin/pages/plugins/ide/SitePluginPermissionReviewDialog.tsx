/**
 * SitePluginPermissionReviewDialog — the consent moment before a
 * grant-changing activation. Shows exactly what `Build & activate` will
 * grant (and revoke): new permissions with labels, removed permissions,
 * and the dangerous-code warning when editor.code is among them. Approval
 * proceeds to activation, where the server additionally enforces
 * plugins.install + step-up.
 */
import { isPluginPermission, permissionLabel } from '@core/plugin-sdk'
import type { SitePluginSummary } from '@core/site-plugins'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import styles from './SitePluginPermissionReviewDialog.module.css'

interface SitePluginPermissionReviewDialogProps {
  summary: SitePluginSummary
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}

export function SitePluginPermissionReviewDialog({
  summary,
  busy,
  onClose,
  onConfirm,
}: SitePluginPermissionReviewDialogProps) {
  const added = summary.newPermissions
  const removed = summary.removedPermissions
  const dangerous = added.includes('editor.code')

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      tone={dangerous ? 'danger' : undefined}
      eyebrow="Permission review"
      title={`Activate ${summary.name}`}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={dangerous ? 'destructive' : 'primary'}
            size="sm"
            type="button"
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-site-plugin-grants"
          >
            {busy ? 'Building…' : 'Grant & activate'}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <p className={styles.intro}>
          Building activates this plugin’s current draft with exactly the
          permissions it declares. You will be asked for your password to
          confirm.
        </p>

        {added.length > 0 && (
          <ul className={styles.list} aria-label="Permissions to grant">
            {added.map((permission) => (
              <li key={permission} className={styles.row}>
                <code className={styles.permissionId}>{permission}</code>
                <span className={styles.permissionLabel}>
                  {isPluginPermission(permission) ? permissionLabel(permission) : permission}
                </span>
              </li>
            ))}
          </ul>
        )}

        {removed.length > 0 && (
          <>
            <p className={styles.removedIntro}>No longer requested (grants shrink):</p>
            <ul className={styles.list} aria-label="Permissions to revoke">
              {removed.map((permission) => (
                <li key={permission} className={styles.rowRemoved}>
                  <code className={styles.permissionId}>{permission}</code>
                </li>
              ))}
            </ul>
          </>
        )}

        {dangerous && (
          <p className={styles.dangerNote} role="alert">
            editor.code runs this plugin’s JavaScript unsandboxed in every
            admin’s browser window. Only activate code you trust.
          </p>
        )}
      </div>
    </Dialog>
  )
}
