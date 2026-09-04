/**
 * HtmlApplyConfirmDialog — the one confirm the HTML panel's Apply can raise,
 * for either or both of its guardrails (docs/features/god-mode.md → "HTML
 * panel" → "Guardrails"):
 *
 *   - the draft is STALE: the projected subtree changed remotely (co-editor,
 *     agent, or a tree undo) since the draft started, so applying overwrites
 *     that work;
 *   - the apply is DESTRUCTIVE: it removes locked nodes or Component/slot
 *     structures, listed by name so the author sees exactly what goes.
 *
 * Every other apply is silent. Cancel returns to the panel with the draft
 * untouched; confirm applies the draft as-is.
 */
import { useRef } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import type { DestructiveRemoval, RemovalReason } from './applyGuardrails'
import styles from './HtmlApplyConfirmDialog.module.css'

interface HtmlApplyConfirmDialogProps {
  stale: boolean
  removals: DestructiveRemoval[]
  onCancel: () => void
  onConfirm: () => void
}

const REASON_LABEL: Record<RemovalReason, string> = {
  locked: 'locked',
  component: 'component instance',
  slot: 'slot',
  outlet: 'slot outlet',
}

function describeRemoval(removal: DestructiveRemoval): string {
  const reasons = removal.reasons.map((reason) => REASON_LABEL[reason]).join(', ')
  return removal.retyped ? `${reasons} — converted to a plain element` : reasons
}

export function HtmlApplyConfirmDialog({ stale, removals, onCancel, onConfirm }: HtmlApplyConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const destructive = removals.length > 0

  return (
    <Dialog
      open
      onClose={onCancel}
      tone="danger"
      eyebrow="HTML panel"
      title={stale ? 'Overwrite remote changes?' : 'Remove protected content?'}
      size="md"
      initialFocusRef={confirmRef}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onCancel} data-testid="html-panel-confirm-cancel">
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            variant="destructive"
            size="sm"
            type="button"
            onClick={onConfirm}
            data-testid="html-panel-confirm"
          >
            {stale ? 'Overwrite' : 'Remove and apply'}
          </Button>
        </>
      }
    >
      <div data-testid="html-panel-confirm-dialog" className={styles.body}>
        {stale ? (
          <p>
            This content changed while you were editing — a co-editor, an agent, or an undo.
            Applying replaces the current content with your draft.
          </p>
        ) : null}
        {destructive ? (
          <>
            <p>{stale ? 'Applying also removes:' : 'Applying removes:'}</p>
            <ul className={styles.list}>
              {removals.map((removal) => (
                <li key={removal.id} className={styles.item}>
                  <span className={styles.name}>{removal.name}</span>
                  <span className={styles.reason}>{describeRemoval(removal)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </Dialog>
  )
}
