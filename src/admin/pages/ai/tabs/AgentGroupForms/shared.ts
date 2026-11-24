import type { ServiceGroup } from '@core/serviceAccounts'
import { getErrorMessage } from '@core/utils/errorMessage'
import { StepUpCancelledMessage } from '@admin/shared/StepUp'
import { pushToast } from '@ui/components/Toast'

export const serviceAccountsPath = '/admin/api/cms/service-accounts'
export type GroupMember = ServiceGroup['members'][number]

export function reportGroupError(title: string, err: unknown) {
  if (err instanceof Error && err.message === StepUpCancelledMessage) return
  pushToast({ kind: 'error', title, body: getErrorMessage(err, title) })
}
