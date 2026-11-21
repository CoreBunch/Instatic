/**
 * Shows an invitation link the admin asked for, so they can pass it on
 * themselves. The server does not store the link and will not show it again;
 * inviting the same address once more makes a fresh one.
 */
import { useId, useRef, useState } from 'react'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import styles from './Members.module.css'

export function InvitationLinkDialog({ email, link, onClose }: { email: string; link: string; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const linkId = useId()
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch (_err) {
      // Clipboard access can be blocked; the link is selected so it can be copied by hand.
      inputRef.current?.select()
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Invitation link"
      size="sm"
      initialFocusRef={inputRef}
      footer={<Button variant="primary" size="sm" type="button" onClick={onClose}>Done</Button>}
    >
      <div className={dialogStyles.form}>
        <div className={dialogStyles.field}>
          <label htmlFor={linkId} className={dialogStyles.label}>Link for {email}</label>
          <div className={styles.linkRow}>
            <Input
              id={linkId}
              ref={inputRef}
              fieldSize="sm"
              value={link}
              readOnly
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button type="button" variant="secondary" size="sm" onClick={() => void copy()}>
              <CopySolidIcon size={12} aria-hidden="true" />
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className={dialogStyles.hint} role="status">{copied ? 'Copied to the clipboard.' : ''}</p>
        </div>
        <p className={dialogStyles.hint}>
          No email was sent. Give this link to {email} yourself. Whoever opens it chooses the password for this
          account, so send it only to them. It works once, lasts 7 days, and is not shown again.
        </p>
      </div>
    </Dialog>
  )
}
