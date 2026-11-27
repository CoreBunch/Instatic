import type { CmsCurrentUser } from '@core/persistence'
import { pushToast } from '@ui/components/Toast'

export interface AccountSecurityProps {
  user: CmsCurrentUser
  busy: string | null
  runStepUp: <T>(fn: () => Promise<T>) => Promise<T>
  setSessionUser: (user: CmsCurrentUser) => void
  setBusy: (operation: string | null) => void
}

export function reportSecurityError(message: string) {
  pushToast({ kind: 'error', title: 'Account update failed', body: message })
}

export function reportSecuritySuccess(message: string) {
  pushToast({ kind: 'success', title: message })
}
