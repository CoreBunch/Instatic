import { useState } from 'react'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { notifyCmsPublicationChanged } from '@admin/state/adminEvents'
import { SitePublishDialog } from '@admin/shared/SitePublishDialog'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import type { PublishVariantSelection } from '@core/localization-schema'
import { publishCmsDraft } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'

export function DashboardPublishButton() {
  const user = useCurrentAdminUser()
  const { runStepUp } = useStepUp()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const canPublish = hasCapability(user, 'pages.publish')

  async function publish(selection: PublishVariantSelection): Promise<boolean> {
    if (!canPublish || busy) return false
    setBusy(true)
    try {
      await runStepUp(() => publishCmsDraft(undefined, undefined, selection))
      notifyCmsPublicationChanged()
      pushToast({ kind: 'success', title: 'Selected page versions published' })
      return true
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return false
      console.error('[DashboardPublishButton] Publication failed:', err)
      pushToast({ kind: 'error', title: 'Publish failed', body: getErrorMessage(err, 'Unable to publish the selected page versions.') })
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!canPublish) return null
  return <>
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(true)}>
      <CloudUploadSolidIcon size={11} aria-hidden="true" /> {busy ? 'Publishing…' : 'Publish pages…'}
    </Button>
    {open && <SitePublishDialog busy={busy} onClose={() => setOpen(false)} onPublish={publish} />}
  </>
}
