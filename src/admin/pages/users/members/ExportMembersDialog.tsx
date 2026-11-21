/**
 * Export every member as one file: CSV for a spreadsheet, JSON with the
 * profile fields too. The download asks for the password again (it is the
 * whole member list) and is recorded in the audit log.
 */
import { useState } from 'react'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { saveFile } from '@admin/lib/saveFile'
import { memberExportFilename, type MemberExportFormat } from '@core/members'
import { downloadAllCmsMembers } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { pushToast } from '@ui/components/Toast'

const FORMAT_HINT: Record<MemberExportFormat, string> = {
  csv: 'One row per member: email, name, status, whether the address is confirmed, tags, when they joined and last signed in. Opens in any spreadsheet.',
  json: 'The same as the CSV, plus every profile field. The file an import reads back most completely.',
}

export function ExportMembersDialog({ total, onClose, onExported }: {
  /** How many members the file will hold. */
  total: number
  onClose: () => void
  /** Called after a download, so the Audit tab shows it. */
  onExported: () => void
}) {
  const { runStepUp } = useStepUp()
  const [format, setFormat] = useState<MemberExportFormat>('csv')
  const [busy, setBusy] = useState(false)

  async function download() {
    setBusy(true)
    try {
      saveFile(await runStepUp(() => downloadAllCmsMembers(format)), memberExportFilename(format))
      onExported()
      onClose()
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      console.error('[ExportMembersDialog] The members could not be exported:', err)
      pushToast({ kind: 'error', title: 'The members could not be exported', body: getErrorMessage(err, 'Unknown export error') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Export members"
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void download()} busy={busy}>
            Download {format.toUpperCase()}
          </Button>
        </>
      }
    >
      <div className={dialogStyles.form}>
        <div className={dialogStyles.field}>
          <span className={dialogStyles.label}>Format</span>
          <SegmentedControl<MemberExportFormat>
            aria-label="File format"
            size="sm"
            value={format}
            options={[
              { value: 'csv', label: 'CSV' },
              { value: 'json', label: 'JSON' },
            ]}
            onChange={setFormat}
          />
          <p className={dialogStyles.hint}>{FORMAT_HINT[format]}</p>
        </div>
        <p className={dialogStyles.hint}>
          {total.toLocaleString()} {total === 1 ? 'member' : 'members'}. No passwords, sessions, sign-in links or IP
          addresses are included. What plugins keep about a member is not in this file; each member&apos;s own
          &ldquo;Download data&rdquo; has it.
        </p>
        <p className={dialogStyles.hint}>
          The file holds personal data. Keep it somewhere safe and delete it when you no longer need it. You will be
          asked for your password, and the export is recorded in the audit log.
        </p>
      </div>
    </Dialog>
  )
}
