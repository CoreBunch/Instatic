/**
 * RoleDialog — create / edit / view modal for CMS roles.
 *
 * `mode === 'view'` is read-only: every input is `disabled`, the submit
 * button is omitted, and the cancel button reads "Close". `'create'` and
 * `'edit'` share the same form layout and submit through `onSubmit`.
 *
 * The capability picker is the shared `CapabilityPicker` (also used by the MCP
 * connector dialog). It renders every CMS capability grouped by feature area
 * (`CAPABILITY_GROUPS`) with human-readable labels + descriptions, a master
 * "Select all / Clear all" header, and a per-group toggle.
 */
import { useId, type FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { SaveSolidIcon } from 'pixel-art-icons/icons/save-solid'
import { CapabilityPicker } from '@admin/shared/CapabilityPicker'
import type { CoreCapability } from '@core/capabilities'
import dialogStyles from '../../../shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import styles from '../UsersPage.module.css'
import type { RoleDialogMode, RoleFormState } from '../types'
import { CAPABILITY_GROUPS } from '../utils/capabilities'

interface RoleDialogProps {
  mode: RoleDialogMode
  form: RoleFormState
  busy: boolean
  error: string | null
  onChange: (form: RoleFormState) => void
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

const ROLE_FORM_ID = 'users-page-role-form'

export function RoleDialog({
  mode,
  form,
  busy,
  error,
  onChange,
  onClose,
  onSubmit,
}: RoleDialogProps) {
  const title = mode === 'create' ? 'Create Role' : mode === 'edit' ? 'Edit Role' : 'View Role'
  const readonly = mode === 'view'

  const nameId = useId()
  const slugId = useId()
  const descriptionId = useId()

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="xl"
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            <span>{readonly ? 'Close' : 'Cancel'}</span>
          </Button>
          {!readonly && (
            <Button type="submit" form={ROLE_FORM_ID} variant="primary" size="sm" disabled={busy}>
              <SaveSolidIcon size={14} aria-hidden="true" />
              <span>{mode === 'create' ? 'Create Role' : 'Save Role'}</span>
            </Button>
          )}
        </>
      }
    >
      <form id={ROLE_FORM_ID} className={dialogStyles.form} onSubmit={(event) => void onSubmit(event)}>
        <div className={styles.roleIdentityGrid}>
          <div className={dialogStyles.field}>
            <label htmlFor={nameId} className={dialogStyles.label}>Name</label>
            <Input
              id={nameId}
              value={form.name}
              required
              disabled={readonly}
              placeholder="Content editor"
              onChange={(event) => onChange({ ...form, name: event.currentTarget.value })}
            />
          </div>
          <div className={dialogStyles.field}>
            <label htmlFor={slugId} className={dialogStyles.label}>Slug</label>
            <Input
              id={slugId}
              value={form.slug}
              disabled={readonly}
              placeholder="content-editor"
              onChange={(event) => onChange({ ...form, slug: event.currentTarget.value })}
            />
          </div>
        </div>
        <div className={dialogStyles.field}>
          <label htmlFor={descriptionId} className={dialogStyles.label}>Description</label>
          <Input
            id={descriptionId}
            value={form.description}
            disabled={readonly}
            placeholder="What can someone with this role do?"
            onChange={(event) => onChange({ ...form, description: event.currentTarget.value })}
          />
        </div>

        <CapabilityPicker
          groups={CAPABILITY_GROUPS}
          selected={new Set(form.capabilities as CoreCapability[])}
          readonly={readonly}
          onChange={(next) => onChange({ ...form, capabilities: [...next] })}
        />

        {error && <p role="alert" className={dialogStyles.errorText}>{error}</p>}
      </form>
    </Dialog>
  )
}
