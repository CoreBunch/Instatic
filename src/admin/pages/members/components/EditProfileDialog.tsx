/**
 * EditProfileDialog — edit a visitor's custom profile field VALUES.
 *
 * Opened from the Visitors table. Reads the configured profile field
 * DEFINITIONS (`getVisitorAuthConfig().profileFields`) and the visitor's
 * current VALUES (`user.profileFields`), renders an input per field, and
 * saves the merged map via `updateVisitorUser({ profileFields })`.
 *
 * Mirrors `AssignGroupsDialog` for dialog/form styling + open-load-save flow.
 * When no profile fields are configured site-wide, the dialog explains that
 * fields are added in Settings → Members.
 */
import { useEffect, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input, Textarea } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Switch } from '@ui/components/Switch'
import { SkeletonBlock } from '@ui/components/Skeleton'
import {
  getVisitorAuthConfig,
  updateVisitorUser,
  type AdminVisitorUser,
  type VisitorProfileField,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'

interface EditProfileDialogProps {
  user: AdminVisitorUser
  onClose: () => void
  /** Fired after a successful save with the persisted profile-field map. */
  onSaved: (profileFields: Record<string, unknown>) => void
}

export function EditProfileDialog({ user, onClose, onSaved }: EditProfileDialogProps) {
  const [fields, setFields] = useState<VisitorProfileField[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Local working copy of the values — seeded from the visitor's current map.
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...(user.profileFields ?? {}),
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load the configured profile field DEFINITIONS on open (best-effort — a
  // load failure surfaces a message rather than blocking the dialog).
  useEffect(() => {
    let cancelled = false
    getVisitorAuthConfig()
      .then((config) => {
        if (!cancelled) setFields(config.profileFields ?? [])
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(getErrorMessage(err, 'Could not load profile field config'))
      })
    return () => {
      cancelled = true
    }
  }, [])

  function setValue(id: string, value: unknown) {
    setValues((current) => ({ ...current, [id]: value }))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const updated = await updateVisitorUser(user.id, { profileFields: values })
      onSaved(updated.profileFields ?? {})
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save profile fields'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onClose={saving ? () => {} : onClose}
      eyebrow="Edit profile"
      title={user.displayName?.trim() || user.email}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || fields === null}
          >
            {saving ? 'Saving…' : 'Save profile'}
          </Button>
        </>
      }
    >
      {loadError ? (
        <p className={dialogStyles.errorText}>{loadError}</p>
      ) : fields === null ? (
        <SkeletonBlock minHeight={120} ariaLabel="Loading profile fields" />
      ) : fields.length === 0 ? (
        <p className={dialogStyles.label}>
          No profile fields are configured yet. Add fields (e.g. School name) in
          <strong> Settings → Members → Profile fields</strong>, then return here to
          set this visitor&rsquo;s values.
        </p>
      ) : (
        <div className={dialogStyles.form} style={{ display: 'grid', gap: 'var(--space-s)' }}>
          {fields.map((field) => (
            <ProfileValueInput
              key={field.id}
              field={field}
              value={values[field.id]}
              onChange={(value) => setValue(field.id, value)}
              disabled={saving}
            />
          ))}
        </div>
      )}
      {error && <p role="alert" className={dialogStyles.errorText}>{error}</p>}
    </Dialog>
  )
}

/** One input row per profile field type. */
function ProfileValueInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: VisitorProfileField
  value: unknown
  onChange: (value: unknown) => void
  disabled: boolean
}) {
  const label = `${field.label}${field.required ? ' *' : ''}`
  switch (field.type) {
    case 'longText':
      return (
        <label className={dialogStyles.field}>
          <span className={dialogStyles.label}>{label}</span>
          <Textarea
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            rows={3}
          />
        </label>
      )
    case 'boolean':
      return (
        <div className={dialogStyles.checkboxRow}>
          <Switch
            checked={value === true || value === 'true'}
            onCheckedChange={onChange}
            disabled={disabled}
          />
          <span className={dialogStyles.label}>{label}</span>
        </div>
      )
    case 'select':
      return (
        <label className={dialogStyles.field}>
          <span className={dialogStyles.label}>{label}</span>
          <Select
            fieldSize="sm"
            value={typeof value === 'string' ? value : ''}
            options={[
              { value: '', label: '— None —' },
              ...(field.options ?? []).map((o) => ({ value: o.value, label: o.label })),
            ]}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
          />
        </label>
      )
    case 'text':
    default:
      return (
        <label className={dialogStyles.field}>
          <span className={dialogStyles.label}>{label}</span>
          <Input
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
          />
        </label>
      )
  }
}
