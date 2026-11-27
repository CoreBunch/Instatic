import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Textarea } from '@ui/components/Input'
import styles from './BranchReviewPage.module.css'

interface ReviewNoteDialogProps {
  eyebrow: string
  title: string
  hint: string
  placeholder: string
  confirmLabel: string
  required: boolean
  tone?: 'danger'
  busy: boolean
  onClose: () => void
  onConfirm: (note: string) => Promise<void>
  testId: string
}

export function ReviewNoteDialog({ eyebrow, title, hint, placeholder, confirmLabel, required, tone, busy, onClose, onConfirm, testId }: ReviewNoteDialogProps) {
  const [note, setNote] = useState('')
  const canConfirm = !busy && (!required || note.trim().length > 0)
  return (
    <Dialog
      open
      size="md"
      tone={tone}
      onClose={busy ? () => {} : onClose}
      eyebrow={eyebrow}
      title={title}
      footer={(
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={tone === 'danger' ? 'destructive' : 'primary'}
            size="sm"
            type="button"
            busy={busy}
            disabled={!canConfirm}
            onClick={() => { void onConfirm(note) }}
            data-testid={`${testId}-confirm`}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <div className={styles.dialogBody}>
        <p className={styles.dialogHint}>{hint}</p>
        <Textarea
          fieldSize="sm"
          rows={4}
          autoFocus
          placeholder={placeholder}
          value={note}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
          data-testid={`${testId}-note`}
        />
      </div>
    </Dialog>
  )
}
