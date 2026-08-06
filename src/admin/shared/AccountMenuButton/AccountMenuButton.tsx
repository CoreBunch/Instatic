/**
 * AccountMenuButton — toolbar avatar trigger + account dropdown.
 *
 * Sits next to `SettingsButton` in `Toolbar.tsx`. Renders a 28×28 circular
 * button showing the user's initials. Clicking opens a compact dropdown:
 *
 *   ┌──────────────────────────────┐
 *   │ Display Name                 │
 *   │ email@example.com            │
 *   │ [OWNER]                      │
 *   ├──────────────────────────────┤
 *   │ Account & security           │  → /admin/account (soft nav)
 *   │ Sign out                     │  → POST /logout, hard reload to /admin
 *   │ Sign out all devices         │  → POST /auth/logout-all, status inline
 *   └──────────────────────────────┘
 *
 * "Sign out" deliberately uses `window.location.assign` instead of a router
 * navigate — the post-logout flow needs a fresh React app boot so the
 * AdminEntry session check re-runs and the unauth login form is rendered.
 *
 * "Sign out all devices" preserves the current cookie server-side so the
 * user issuing the action stays signed in here. Status is surfaced inline.
 *
 * The button stays signed-out-safe: when there is no current user (admin
 * shell hasn't hydrated yet), the component returns null.
 */
import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@ui/components/ContextMenu'
import { SettingsCogSolidIcon } from 'pixel-art-icons/icons/settings-cog-solid'
import { PowerOffIcon } from 'pixel-art-icons/icons/power-off'
import { MonitorSolidIcon } from 'pixel-art-icons/icons/monitor-solid'
import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import { LOCALE_NATIVE_NAMES, useI18n } from '@admin/i18n'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { UserAvatar } from '@admin/shared/UserAvatar'
import { logoutAllOtherCmsSessions, logoutCms } from '@core/persistence'
import styles from './AccountMenuButton.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

const ACCOUNT_ROUTE = '/admin/account'

export function AccountMenuButton(): ReactNode {
  const user = useAuthenticatedAdminUser()
  const navigate = useAdminNavigate()
  const { runStepUp } = useStepUp()
  const { locale, setLocale, t } = useI18n()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<null | 'logout' | 'logout-all'>(null)
  const [status, setStatus] = useState<{ tone: 'info' | 'error'; message: string } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const displayName = user.displayName.trim() || user.email
  const roleLabel = user.role.name

  function close(): void {
    setOpen(false)
    setStatus(null)
  }

  async function handleSignOut(): Promise<void> {
    if (busy) return
    setBusy('logout')
    setStatus(null)
    try {
      await logoutCms()
      // Hard navigation is intentional here — the next request must boot the
      // admin shell from scratch so the unauth login form renders. A soft
      // navigate would keep the React tree alive with stale session state.
      window.location.assign('/admin')
    } catch (err) {
      console.error('[account-menu] sign out failed:', err)
      setBusy(null)
      setStatus({
        tone: 'error',
        message: getErrorMessage(err, 'Could not sign out.'),
      })
    }
  }

  async function handleSignOutAllDevices(): Promise<void> {
    if (busy) return
    setBusy('logout-all')
    setStatus(null)
    try {
      const revokedCount = await runStepUp(() => logoutAllOtherCmsSessions())
      setBusy(null)
      const noun = revokedCount === 1 ? 'device' : 'devices'
      setStatus({
        tone: 'info',
        message: revokedCount === 0
          ? 'No other devices were signed in.'
          : `Signed out ${revokedCount} ${noun}.`,
      })
    } catch (err) {
      setBusy(null)
      // Cancelled step-up is a normal flow, not an error to surface.
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      console.error('[account-menu] sign out all devices failed:', err)
      setStatus({
        tone: 'error',
        message: getErrorMessage(err, 'Could not sign out other devices.'),
      })
    }
  }

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="xs"
        type="button"
        active={open}
        aria-label={`Account menu for ${displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={styles.trigger}
        data-testid="account-menu-trigger"
        data-active={open ? 'true' : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <UserAvatar user={user} size={26} alt={null} className={styles.triggerAvatar} />
      </Button>
      {open && typeof document !== 'undefined' && createPortal(
        <ContextMenu
          ariaLabel="Account menu"
          onClose={close}
          anchorRef={triggerRef}
          side="bottom"
          align="end"
          width={240}
          zIndex={10000}
        >
          <header className={styles.header}>
            <span className={styles.headerName}>{displayName}</span>
            <span className={styles.headerEmail}>{user.email}</span>
            <span className={styles.headerRoleRow}>
              <span className={styles.roleBadge}>{roleLabel}</span>
            </span>
          </header>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => {
              close()
              navigate(ACCOUNT_ROUTE)
            }}
            data-testid="account-menu-go-to-account"
          >
            <SettingsCogSolidIcon size={12} aria-hidden="true" />
            <span>Account &amp; security</span>
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              const nextLocale = locale === 'zh-CN' ? 'en' : 'zh-CN'
              setLocale(nextLocale)
              close()
            }}
            data-testid="account-menu-switch-language"
          >
            <GlobeSolidIcon size={12} aria-hidden="true" />
            <span>{t('language.switchTo', { language: LOCALE_NATIVE_NAMES[locale === 'zh-CN' ? 'en' : 'zh-CN'] })}</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => void handleSignOut()}
            disabled={busy !== null}
            data-testid="account-menu-sign-out"
          >
            <PowerOffIcon size={12} aria-hidden="true" />
            <span>{busy === 'logout' ? 'Signing out…' : 'Sign out'}</span>
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => void handleSignOutAllDevices()}
            disabled={busy !== null}
            data-testid="account-menu-sign-out-all"
          >
            <MonitorSolidIcon size={12} aria-hidden="true" />
            <span>{busy === 'logout-all' ? 'Signing out other devices…' : 'Sign out all devices'}</span>
          </ContextMenuItem>
          {status && (
            <p
              className={status.tone === 'error' ? `${styles.status} ${styles.statusError}` : styles.status}
              role={status.tone === 'error' ? 'alert' : 'status'}
            >
              {status.message}
            </p>
          )}
        </ContextMenu>,
        document.body,
      )}
    </>
  )
}
