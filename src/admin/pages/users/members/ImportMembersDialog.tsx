/**
 * Import members from a CSV or JSON file, in two steps: a preview that says
 * what would happen (new addresses, ones that already have an account,
 * rows that cannot be imported and why), then the import itself, which asks
 * for the password again.
 *
 * Existing members are skipped, or only given tags: their status, password
 * and confirmation never change. New members get no password and no email,
 * unless invitations are turned on.
 */
import { useId, useState, type ChangeEvent } from 'react'
import { MemberTagsInput } from '@admin/shared/AccessRuleEditor'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import {
  MEMBER_IMPORT_MAX_BYTES,
  MEMBER_IMPORT_MAX_ROWS,
  type MemberExportFormat,
  type MemberImportPreview,
  type MemberImportProblem,
  type MemberImportRequest,
  type MemberImportResult,
} from '@core/members'
import { importCmsMembers, previewCmsMemberImport } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { FileUpload } from '@ui/components/FileUpload'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Switch } from '@ui/components/Switch'
import { pushToast } from '@ui/components/Toast'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import styles from './Members.module.css'

type Existing = MemberImportRequest['existing']

interface ChosenFile {
  name: string
  format: MemberExportFormat
  content: string
}

const MAX_MB = MEMBER_IMPORT_MAX_BYTES / 1024 / 1024

function formatOf(file: File): MemberExportFormat {
  return file.name.toLowerCase().endsWith('.json') || file.type === 'application/json' ? 'json' : 'csv'
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

function ProblemList({ problems, total }: { problems: readonly MemberImportProblem[]; total: number }) {
  if (problems.length === 0) return null
  return (
    <div className={styles.importProblems}>
      <ul aria-label="Rows that were not imported">
        {problems.map((problem) => (
          <li key={`${problem.row}-${problem.email}`}>
            <span className={styles.importRow}>Row {problem.row}</span>
            <span className={styles.importEmail}>{problem.email || '(no address)'}</span>
            <span>{problem.reason}</span>
          </li>
        ))}
      </ul>
      {total > problems.length && <p className={dialogStyles.hint}>And {plural(total - problems.length, 'more row', 'more rows')}.</p>}
    </div>
  )
}

export function ImportMembersDialog({
  invitationBlocked,
  onClose,
  onImported,
}: {
  /** Why invitations cannot be sent from here, or undefined when they can. */
  invitationBlocked: string | undefined
  onClose: () => void
  /** Called after an import, so the list and the Audit tab follow. */
  onImported: () => void
}) {
  const { runStepUp } = useStepUp()
  const fileLabelId = useId()
  const [file, setFile] = useState<ChosenFile | null>(null)
  const [fileProblem, setFileProblem] = useState<string | null>(null)
  const [existing, setExisting] = useState<Existing>('skip')
  const [tags, setTags] = useState<string[]>([])
  const [invite, setInvite] = useState(false)
  const [preview, setPreview] = useState<MemberImportPreview | null>(null)
  const [result, setResult] = useState<MemberImportResult | null>(null)
  const [busy, setBusy] = useState(false)

  const request: MemberImportRequest | null = file
    ? { format: file.format, content: file.content, existing, tags, invite: invite && !invitationBlocked }
    : null
  const changes = preview ? preview.new + (existing === 'tags' ? preview.existing : 0) : 0
  const inviteProblem = invite && preview && !preview.invitations.available ? preview.invitations.reason : undefined

  /** Any change to the file or the options makes the preview out of date. */
  function change<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setPreview(null)
    }
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!chosen) return
    setPreview(null)
    if (chosen.size > MEMBER_IMPORT_MAX_BYTES) {
      setFile(null)
      setFileProblem(`${chosen.name} is larger than ${MAX_MB} MB. Split it into smaller files.`)
      return
    }
    try {
      setFile({ name: chosen.name, format: formatOf(chosen), content: await chosen.text() })
      setFileProblem(null)
    } catch (err) {
      console.error('[ImportMembersDialog] The file could not be read:', err)
      setFile(null)
      setFileProblem(`${chosen.name} could not be read.`)
    }
  }

  async function runPreview() {
    if (!request) return
    setBusy(true)
    try {
      setPreview(await previewCmsMemberImport(request))
    } catch (err) {
      console.error('[ImportMembersDialog] The file could not be checked:', err)
      pushToast({ kind: 'error', title: 'The file could not be checked', body: getErrorMessage(err, 'Unknown import error') })
    } finally {
      setBusy(false)
    }
  }

  async function runImport() {
    if (!request) return
    setBusy(true)
    try {
      const done = await runStepUp(() => importCmsMembers(request))
      setResult(done)
      onImported()
      pushToast({
        kind: done.failed > 0 ? 'error' : 'success',
        title: done.failed > 0 ? 'Some members could not be imported' : 'Members imported',
        body: `${plural(done.created, 'member', 'members')} added${done.tagged ? `, ${plural(done.tagged, 'member', 'members')} given tags` : ''}.`,
      })
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      console.error('[ImportMembersDialog] The members could not be imported:', err)
      pushToast({ kind: 'error', title: 'The members could not be imported', body: getErrorMessage(err, 'Unknown import error') })
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    return (
      <Dialog
        open
        onClose={onClose}
        title="Import finished"
        size="md"
        footer={<Button variant="primary" size="sm" type="button" onClick={onClose}>Back to members</Button>}
      >
        <div className={dialogStyles.form}>
          <dl className={styles.importCounts} data-columns="3">
            <div><dt>Added</dt><dd>{result.created.toLocaleString()}</dd></div>
            <div><dt>Invited</dt><dd>{result.invited.toLocaleString()}</dd></div>
            <div><dt>Given tags</dt><dd>{result.tagged.toLocaleString()}</dd></div>
            <div><dt>Left as they were</dt><dd>{result.skipped.toLocaleString()}</dd></div>
            <div><dt>Not valid</dt><dd>{result.invalid.toLocaleString()}</dd></div>
            <div><dt>Failed</dt><dd>{result.failed.toLocaleString()}</dd></div>
          </dl>
          {result.failed > 0 && (
            <p className={dialogStyles.hint}>
              Each failed row says what was not saved. Importing the same file again adds the members that are missing;
              choose &ldquo;Add tags only&rdquo; to also finish the tags of an account that was created.
            </p>
          )}
          <ProblemList problems={result.problems} total={result.invalid + result.failed} />
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Import members"
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>Cancel</Button>
          {preview ? (
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={() => void runImport()}
              busy={busy}
              disabled={changes === 0 || inviteProblem !== undefined}
              tooltip={changes === 0 ? 'Nothing in this file would change.' : inviteProblem}
            >
              {existing === 'tags' && preview.existing > 0
                ? `Import ${plural(preview.new, 'member', 'members')}, tag ${preview.existing.toLocaleString()}`
                : `Import ${plural(preview.new, 'member', 'members')}`}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={() => void runPreview()}
              busy={busy}
              disabled={!request}
              tooltip={request ? undefined : 'Choose a file first.'}
            >
              Check file
            </Button>
          )}
        </>
      }
    >
      <div className={dialogStyles.form}>
        <div className={dialogStyles.field}>
          <span id={fileLabelId} className={dialogStyles.label}>File</span>
          <div className={styles.importFileRow}>
            <FileUpload
              accept=".csv,.json,text/csv,application/json"
              onChange={(event) => void chooseFile(event)}
              buttonProps={{ variant: 'secondary', size: 'sm', disabled: busy, 'aria-describedby': fileLabelId }}
            >
              <UploadIcon size={12} aria-hidden="true" />
              {file ? 'Choose another file' : 'Choose a file'}
            </FileUpload>
            {file && <span className={styles.importFileName}>{file.name} ({file.format.toUpperCase()})</span>}
          </div>
          {fileProblem && <p className={dialogStyles.errorText} role="alert">{fileProblem}</p>}
          <p className={dialogStyles.hint}>
            A CSV with an <code>email</code> column (and optionally <code>name</code>, <code>tags</code> and a column
            per profile field), or the JSON file an export makes. At most {MEMBER_IMPORT_MAX_ROWS.toLocaleString()} rows
            and {MAX_MB} MB. Status, confirmation and dates in the file are not imported.
          </p>
        </div>

        <div className={dialogStyles.field}>
          <span className={dialogStyles.label}>Addresses that already have an account</span>
          <SegmentedControl<Existing>
            aria-label="Addresses that already have an account"
            size="sm"
            value={existing}
            options={[
              { value: 'skip', label: 'Leave them as they are' },
              { value: 'tags', label: 'Add tags only' },
            ]}
            onChange={change(setExisting)}
          />
          <p className={dialogStyles.hint}>
            {existing === 'skip'
              ? 'Existing members are not changed at all.'
              : "Existing members get the file's tags and the tags below. Nothing else about them changes."}
          </p>
        </div>

        <div className={dialogStyles.field}>
          <span className={dialogStyles.label}>Tags for everyone in the file (optional)</span>
          <MemberTagsInput value={tags} onChange={change(setTags)} disabled={busy} />
        </div>

        <div className={dialogStyles.field}>
          <div className={styles.importSwitch}>
            <Switch
              checked={invite && !invitationBlocked}
              switchSize="sm"
              disabled={invitationBlocked !== undefined || busy}
              onCheckedChange={change(setInvite)}
              aria-label="Email an invitation to each new member"
            />
            <span aria-hidden="true">Email an invitation to each new member</span>
          </div>
          <p className={dialogStyles.hint}>
            {invitationBlocked ??
              (invite
                ? 'Each new member gets an email with a link to choose a password. Turn this on only for people who expect to hear from you.'
                : 'New members get no email and no password. They get in by asking for a sign-in link or a password reset, or when you invite them later.')}
          </p>
        </div>

        {preview && (
          <div className={styles.importPreview} role="status">
            <dl className={styles.importCounts}>
              <div><dt>Rows</dt><dd>{preview.rows.toLocaleString()}</dd></div>
              <div><dt>New</dt><dd>{preview.new.toLocaleString()}</dd></div>
              <div><dt>Existing</dt><dd>{preview.existing.toLocaleString()}</dd></div>
              <div><dt>Not valid</dt><dd>{preview.invalid.toLocaleString()}</dd></div>
            </dl>
            {inviteProblem && <p className={dialogStyles.errorText}>{inviteProblem}</p>}
            {preview.ignored.length > 0 && (
              <p className={dialogStyles.hint}>Not imported from the file: {preview.ignored.join(', ')}.</p>
            )}
            <ProblemList problems={preview.problems} total={preview.invalid} />
          </div>
        )}

        <p className={dialogStyles.hint}>
          Import only people you have a lawful reason to hold an account for, such as customers or people who asked to
          join. The import is recorded in the audit log.
        </p>
      </div>
    </Dialog>
  )
}
