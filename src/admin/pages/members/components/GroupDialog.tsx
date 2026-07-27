/**
 * GroupDialog — create / edit modal for visitor member-groups (Phase 3 — D13/D15).
 *
 * Mirrors `RoleDialog.tsx` in structure. A group carries a name, a landing
 * path (where members of the group are sent on login when no explicit redirect
 * applies — defaults to `/`), and an optional description. A duplicate name is
 * rejected server-side with a 409, surfaced here via the `error` prop.
 */
import { useId, type FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { SaveSolidIcon } from 'pixel-art-icons/icons/save-solid'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import pageStyles from '../MembersPage.module.css'
import type { VisitorGroupDialogMode, VisitorGroupFormState } from '../types'

interface GroupDialogProps {
  mode: VisitorGroupDialogMode
  form: VisitorGroupFormState
  busy: boolean
  error: string | null
  onChange: (form: VisitorGroupFormState) => void
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

const GROUP_FORM_ID = 'members-page-group-form'

export function GroupDialog({
  mode,
  form,
  busy,
  error,
  onChange,
  onClose,
  onSubmit,
}: GroupDialogProps) {
  const title = mode === 'create' ? 'Create Group' : 'Edit Group'
  const nameId = useId()
  const landingPathId = useId()
  const descriptionId = useId()

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="md"
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            <span>Cancel</span>
          </Button>
          <Button type="submit" form={GROUP_FORM_ID} variant="primary" size="sm" disabled={busy}>
            <SaveSolidIcon size={14} aria-hidden="true" />
            <span>{mode === 'create' ? 'Create Group' : 'Save Group'}</span>
          </Button>
        </>
      }
    >
      <form id={GROUP_FORM_ID} className={dialogStyles.form} onSubmit={(event) => void onSubmit(event)}>
        <div className={dialogStyles.field}>
          <label htmlFor={nameId} className={dialogStyles.label}>Name</label>
          <Input
            id={nameId}
            value={form.name}
            required
            maxLength={100}
            disabled={busy}
            placeholder="Founders"
            onChange={(event) => onChange({ ...form, name: event.currentTarget.value })}
          />
        </div>
        <div className={dialogStyles.field}>
          <label htmlFor={landingPathId} className={dialogStyles.label}>
            Landing path <span className={pageStyles.fieldHint}>(where members land on login; defaults to /)</span>
          </label>
          <Input
            id={landingPathId}
            value={form.landingPath}
            disabled={busy}
            placeholder="/"
            onChange={(event) => onChange({ ...form, landingPath: event.currentTarget.value })}
          />
        </div>
        <div className={dialogStyles.field}>
          <label htmlFor={descriptionId} className={dialogStyles.label}>
            Description <span className={pageStyles.fieldHint}>(optional)</span>
          </label>
          <Input
            id={descriptionId}
            value={form.description}
            maxLength={500}
            disabled={busy}
            placeholder="Early-access founding members"
            onChange={(event) => onChange({ ...form, description: event.currentTarget.value })}
          />
        </div>

        {error && <p role="alert" className={dialogStyles.errorText}>{error}</p>}
      </form>
    </Dialog>
  )
}
