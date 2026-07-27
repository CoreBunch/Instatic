/**
 * RoleDialog — create / edit modal for visitor roles.
 *
 * Mirrors `pages/users/components/RoleDialog.tsx` in structure but is simpler:
 * visitor roles carry only a name + free-form capability strings (no slug,
 * no description, and Phase-1 capabilities are NOT the closed `CoreCapability`
 * enum, so there is no grouped `CapabilityPicker`). Capabilities are entered
 * as a comma-separated list and rendered back as `TagPill` chips so the admin
 * sees exactly what will be persisted.
 */
import { useId, type FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { TagPill } from '@ui/components/TagPill'
import { SaveSolidIcon } from 'pixel-art-icons/icons/save-solid'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import pageStyles from '../MembersPage.module.css'
import type { VisitorRoleDialogMode, VisitorRoleFormState } from '../types'

interface RoleDialogProps {
  mode: VisitorRoleDialogMode
  form: VisitorRoleFormState
  busy: boolean
  error: string | null
  onChange: (form: VisitorRoleFormState) => void
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

const ROLE_FORM_ID = 'members-page-role-form'

/**
 * Parse a comma-separated string into a de-duplicated, ordered list of
 * non-empty trimmed capability strings. Preserves first-seen order so the
 * admin's typing order is respected.
 */
function parseCapabilities(raw: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

/** Render a capability list back as the comma-separated string for the input. */
function capabilitiesToText(capabilities: string[]): string {
  return capabilities.join(', ')
}

export function RoleDialog({
  mode,
  form,
  busy,
  error,
  onChange,
  onClose,
  onSubmit,
}: RoleDialogProps) {
  const title = mode === 'create' ? 'Create Visitor Role' : 'Edit Visitor Role'
  const nameId = useId()
  const capabilitiesId = useId()

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
          <Button type="submit" form={ROLE_FORM_ID} variant="primary" size="sm" disabled={busy}>
            <SaveSolidIcon size={14} aria-hidden="true" />
            <span>{mode === 'create' ? 'Create Role' : 'Save Role'}</span>
          </Button>
        </>
      }
    >
      <form id={ROLE_FORM_ID} className={dialogStyles.form} onSubmit={(event) => void onSubmit(event)}>
        <div className={dialogStyles.field}>
          <label htmlFor={nameId} className={dialogStyles.label}>Name</label>
          <Input
            id={nameId}
            value={form.name}
            required
            maxLength={100}
            disabled={busy}
            placeholder="editor"
            onChange={(event) => onChange({ ...form, name: event.currentTarget.value })}
          />
        </div>
        <div className={dialogStyles.field}>
          <label htmlFor={capabilitiesId} className={dialogStyles.label}>
            Capabilities <span className={pageStyles.fieldHint}>(comma-separated, e.g. content.read, content.write)</span>
          </label>
          <Input
            id={capabilitiesId}
            value={capabilitiesToText(form.capabilities)}
            disabled={busy}
            placeholder="content.read, content.write"
            onChange={(event) =>
              onChange({ ...form, capabilities: parseCapabilities(event.currentTarget.value) })
            }
          />
          {form.capabilities.length > 0 && (
            <div className={pageStyles.capChips} aria-live="polite">
              {form.capabilities.map((capability) => (
                <TagPill key={capability} label={capability} size="xs" />
              ))}
            </div>
          )}
        </div>

        {error && <p role="alert" className={dialogStyles.errorText}>{error}</p>}
      </form>
    </Dialog>
  )
}
