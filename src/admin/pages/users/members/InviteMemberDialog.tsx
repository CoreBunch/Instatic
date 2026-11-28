import { useState } from 'react'
import { MemberTagsInput } from '@admin/shared/AccessRuleEditor'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import { InviteAccountDialog } from '../components/InviteAccountDialog'

export function InviteMemberDialog({ busy, mailAvailable, onClose, onInvite }: {
  busy: boolean
  mailAvailable: boolean
  onClose: () => void
  onInvite: (email: string, tags: string[], delivery: 'email' | 'link') => void
}) {
  const [tags, setTags] = useState<string[]>([])
  return (
    <InviteAccountDialog title="Invite a member" busy={busy} mailAvailable={mailAvailable} onClose={onClose}
      onInvite={(email, delivery) => onInvite(email, tags, delivery)}>
      <div className={dialogStyles.field}>
        <span className={dialogStyles.label}>Tags (optional)</span>
        <MemberTagsInput value={tags} onChange={setTags} disabled={busy} />
      </div>
    </InviteAccountDialog>
  )
}
