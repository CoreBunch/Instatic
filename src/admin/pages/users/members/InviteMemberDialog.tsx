/**
 * Invite a member: an address and, optionally, the tags they should hold
 * from the moment they accept. The server emails a single-use link, or,
 * when asked (always, while outgoing email is not set up), hands the link to
 * the admin to pass on themselves.
 */
import { useId, useRef, useState, type FormEvent } from 'react'
import { MemberTagsInput } from '@admin/shared/AccessRuleEditor'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import { MAIL_ADDRESS_PATTERN } from '@core/mail'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'

const FORM_ID = 'invite-member-form'
const ADDRESS_RE = new RegExp(MAIL_ADDRESS_PATTERN)

export function InviteMemberDialog({
  busy,
  mailAvailable,
  onClose,
  onInvite,
}: {
  busy: boolean
  /** Whether the site can email the link. When it cannot, the only way is a link to pass on. */
  mailAvailable: boolean
  onClose: () => void
  onInvite: (email: string, tags: string[], delivery: 'email' | 'link') => void
}) {
  const [email, setEmail] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const emailId = useId()
  const valid = ADDRESS_RE.test(email.trim())

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (valid && !busy) onInvite(email.trim(), tags, mailAvailable ? 'email' : 'link')
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Invite a member"
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>Cancel</Button>
          {mailAvailable && (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={!valid || busy}
              tooltip="Sends no email. You get the link to pass on yourself."
              onClick={() => onInvite(email.trim(), tags, 'link')}
            >
              Create a link instead
            </Button>
          )}
          <Button variant="primary" size="sm" type="submit" form={FORM_ID} disabled={!valid} busy={busy}>
            {mailAvailable ? 'Send invitation' : 'Create invitation link'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className={dialogStyles.form} onSubmit={handleSubmit}>
        <div className={dialogStyles.field}>
          <label htmlFor={emailId} className={dialogStyles.label}>Email address</label>
          <Input
            id={emailId}
            ref={inputRef}
            type="email"
            fieldSize="sm"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="person@example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className={dialogStyles.field}>
          <span className={dialogStyles.label}>Tags (optional)</span>
          <MemberTagsInput value={tags} onChange={setTags} disabled={busy} />
        </div>
        <p className={dialogStyles.hint}>
          {mailAvailable
            ? 'They get an email with a link to choose a password. The link works once and lasts 7 days. Inviting the same address again sends a fresh link.'
            : 'Outgoing email is not set up, so nothing is sent. You get a link to pass on yourself. It works once and lasts 7 days. Set up a connector under Email to have invitations sent for you.'}
        </p>
      </form>
    </Dialog>
  )
}
