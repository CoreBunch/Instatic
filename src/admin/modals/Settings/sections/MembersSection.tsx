/**
 * MembersSection — visitor-auth configuration (Settings → Members).
 *
 * Self-contained settings form that loads the current visitor-auth config
 * and the visitor role list on mount, lets an admin toggle auth on/off,
 * open/close registration, set the login path, pick the default role, and
 * set the default landing path for a logged-in visitor with no primary-group
 * landing (D15). Saves via {@link saveVisitorAuthConfig}.
 *
 * Page-level protection is configured per-page in the editor (D14 — each
 * page carries an `access` field; see the page "Access" control), NOT in
 * this settings section. The retired Phase-1/2 `protectedPrefixes` model is
 * gone.
 *
 * The whole section is gated by the `users.manage` capability — the same
 * capability the server-side `/admin/api/cms/visitor-auth/*` routes require.
 * Admins without it see a notice instead of the form.
 */
import { useEffect, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Switch } from '@ui/components/Switch'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import {
  getVisitorAuthConfig,
  listVisitorRoles,
  saveVisitorAuthConfig,
  type VisitorAuthConfig,
  type VisitorProfileField,
  type VisitorRole,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import s from '../SettingsModal.module.css'
import styles from './MembersSection.module.css'

export function MembersSection() {
  const currentUser = useCurrentAdminUser()
  // `currentUser === null` only happens outside AdminSessionProvider (layout
  // tests / SSR). Treat it as unrestricted there to keep preview mode
  // usable; the real browser session always carries a user.
  const canManage = !currentUser || hasCapability(currentUser, 'users.manage')

  if (!canManage) {
    return (
      <p className={s.sectionDescription} role="alert">
        You need the Users manage permission to configure visitor authentication.
      </p>
    )
  }

  return <MembersConfigForm />
}

interface LoadedState {
  config: VisitorAuthConfig
  roles: VisitorRole[]
}

function MembersConfigForm() {
  const [loaded, setLoaded] = useState<LoadedState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([getVisitorAuthConfig(), listVisitorRoles()])
      .then(([config, roles]) => {
        if (cancelled) return
        setLoaded({ config, roles })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(getErrorMessage(err, 'Could not load visitor-auth settings'))
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loadError) {
    return <p className={s.sectionDescription} role="alert">{loadError}</p>
  }
  if (!loaded) {
    return <SkeletonBlock minHeight={200} ariaLabel="Loading visitor-auth settings" />
  }

  return <MembersConfigFields initial={loaded.config} roles={loaded.roles} />
}

interface MembersConfigFieldsProps {
  initial: VisitorAuthConfig
  roles: VisitorRole[]
}

function MembersConfigFields({ initial, roles }: MembersConfigFieldsProps) {
  const [enabled, setEnabled] = useState(initial.enabled)
  const [registrationOpen, setRegistrationOpen] = useState(initial.registrationOpen)
  const [loginPath, setLoginPath] = useState(initial.loginPath || '/login')
  const [defaultRole, setDefaultRole] = useState(initial.defaultRole || '')
  // D15: where a logged-in visitor with no primary-group landing is sent.
  // Defaults to `/` when the saved config lacks a value.
  const [defaultLandingPath, setDefaultLandingPath] = useState(initial.defaultLandingPath || '/')
  // Per-visitor-data framework: site-builder-defined custom profile fields
  // (e.g. "School name"). Values are stored per-visitor.
  const [profileFields, setProfileFields] = useState<VisitorProfileField[]>(
    initial.profileFields ?? []
  )

  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null)

  // Role picker options. The saved defaultRole can be a role id OR a role
  // name (the server accepts both on save); make sure the current value is
  // always selectable even if it no longer matches a row, so the dropdown
  // doesn't silently snap to the first option.
  const roleOptions = buildRoleOptions(roles, defaultRole)

  async function handleSave() {
    setSaving(true)
    setStatus(null)
    try {
      const config = await saveVisitorAuthConfig({
        enabled,
        registrationOpen,
        loginPath: loginPath.trim() || '/login',
        defaultRole,
        defaultLandingPath: defaultLandingPath.trim() || '/',
        profileFields,
      })
      // Reconcile local state with the server's cleaned response.
      setEnabled(config.enabled)
      setRegistrationOpen(config.registrationOpen)
      setLoginPath(config.loginPath)
      setDefaultRole(config.defaultRole)
      setDefaultLandingPath(config.defaultLandingPath || '/')
      setProfileFields(config.profileFields ?? [])
      setStatus({ kind: 'ok', message: 'Visitor-auth settings saved.' })
    } catch (err) {
      setStatus({ kind: 'error', message: getErrorMessage(err, 'Could not save visitor-auth settings') })
    } finally {
      setSaving(false)
    }
  }

  const enabledId = 'members-enabled'
  const registrationId = 'members-registration-open'

  return (
    <div>
      <p className={s.sectionDescription}>
        Control whether visitors can register and sign in, and where a logged-in
        visitor lands. Page-level access is set per page in the editor.
      </p>

      <section aria-labelledby="members-general-heading" className={s.sectionBlock}>
        <h4 id="members-general-heading" className={s.subHeading}>General</h4>

        <div className={s.cardGroup}>
          <div className={s.toggleRow}>
            <div className={s.toggleRowContent}>
              <label htmlFor={enabledId} className={s.toggleRowLabel}>
                Enable visitor authentication
              </label>
              <p className={s.toggleRowDesc}>
                Enabling visitor auth lets visitors register and log in to protected pages.
              </p>
            </div>
            <Switch
              id={enabledId}
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={saving}
            />
          </div>

          <div className={s.toggleRow}>
            <div className={s.toggleRowContent}>
              <label htmlFor={registrationId} className={s.toggleRowLabel}>
                Open registration
              </label>
              <p className={s.toggleRowDesc}>
                When on, visitors can create their own accounts. Turn off to make
                sign-up invite-only (accounts must be created another way).
              </p>
            </div>
            <Switch
              id={registrationId}
              checked={registrationOpen}
              onCheckedChange={setRegistrationOpen}
              disabled={saving}
            />
          </div>
        </div>

        <div className={s.genFieldRow}>
          <label htmlFor="members-login-path" className={s.label}>
            Login path
          </label>
          <Input
            id="members-login-path"
            type="text"
            value={loginPath}
            onChange={(e) => setLoginPath(e.target.value)}
            disabled={saving}
            placeholder="/login"
          />
        </div>

        <div className={s.genFieldRow}>
          <label htmlFor="members-default-role" className={s.label}>
            Default role
          </label>
          <Select
            id="members-default-role"
            fieldSize="sm"
            value={defaultRole}
            options={roleOptions}
            onChange={(e) => setDefaultRole(e.target.value)}
            disabled={saving}
            aria-label="Default visitor role"
          />
        </div>
      </section>

      <section aria-labelledby="members-landing-heading" className={s.sectionBlock}>
        <h4 id="members-landing-heading" className={s.subHeading}>Default landing path</h4>
        <p className={s.toggleRowDesc}>
          Where a logged-in visitor is sent when no explicit redirect or
          primary-group landing applies. Must start with {` "/" `} — e.g.
          <code>/members</code>.
        </p>
        <div className={s.genFieldRow}>
          <label htmlFor="members-default-landing" className={s.label}>
            Default landing path
          </label>
          <Input
            id="members-default-landing"
            type="text"
            value={defaultLandingPath}
            onChange={(e) => setDefaultLandingPath(e.target.value)}
            disabled={saving}
            placeholder="/"
          />
        </div>
        <p className={s.toggleRowDesc}>
          Control which pages members see via each page&rsquo;s Access setting in the editor.
        </p>
      </section>

      <section aria-labelledby="members-profile-heading" className={s.sectionBlock}>
        <h4 id="members-profile-heading" className={s.subHeading}>Profile fields</h4>
        <p className={s.toggleRowDesc}>
          Custom fields each visitor can carry (e.g. a school name) and that you
          can display on member pages with the <code>visitor.current</code> loop.
          Visitors cannot edit these from the portal — values are set here or
          via the Members workspace.
        </p>
        <ProfileFieldEditor fields={profileFields} onChange={setProfileFields} disabled={saving} />
      </section>

      <div className={styles.actions}>
        <Button
          variant="primary"
          size="sm"
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
        {status && (
          <p
            className={styles.status}
            data-kind={status.kind}
            role={status.kind === 'error' ? 'alert' : 'status'}
          >
            {status.message}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Build the `<select>` option list for the default-role picker. If the
 * currently-saved value isn't one of the rows (e.g. a role was renamed /
 * the value is a name rather than an id), prepend a placeholder option so
 * the dropdown still shows what's persisted instead of snapping to the
 * first row.
 */
function buildRoleOptions(
  roles: VisitorRole[],
  currentValue: string,
): { value: string; label: string }[] {
  const options = roles.map((role) => ({ value: role.id, label: role.name }))
  const valueIsKnown = options.some((option) => option.value === currentValue)
  if (!valueIsKnown && currentValue) {
    return [{ value: currentValue, label: `${currentValue} (not a current role)` }, ...options]
  }
  return options
}

/** Allowed profile field types — mirrors VisitorProfileFieldType. */
const PROFILE_FIELD_TYPE_OPTIONS = [
  { value: 'text', label: 'Text' },
  { value: 'longText', label: 'Long text' },
  { value: 'boolean', label: 'Toggle' },
  { value: 'select', label: 'Select' },
]

/**
 * Editor for the site-builder-defined visitor profile field DEFINITIONS.
 * Add/remove rows; each row sets an id (machine key), label, type, and
 * optional required flag. Rows persist in visitor_auth_config.profileFields
 * via the enclosing form's save.
 */
function ProfileFieldEditor({
  fields,
  onChange,
  disabled,
}: {
  fields: VisitorProfileField[]
  onChange: (next: VisitorProfileField[]) => void
  disabled: boolean
}) {
  function update(index: number, patch: Partial<VisitorProfileField>) {
    onChange(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)))
  }
  function remove(index: number) {
    onChange(fields.filter((_, i) => i !== index))
  }
  function add() {
    onChange([
      ...fields,
      { id: `field${fields.length + 1}`, label: '', type: 'text' },
    ])
  }

  return (
    <div className={s.cardGroup}>
      {fields.map((field, index) => (
        <div
          key={index}
          className={s.genFieldRow}
          style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.4fr 1fr auto auto', gap: 'var(--space-2xs)', alignItems: 'end' }}
        >
          <div className={s.fieldHint}>
            <label htmlFor={`pf-id-${index}`} className={s.label}>Field key</label>
            <Input
              id={`pf-id-${index}`}
              type="text"
              value={field.id}
              onChange={(e) => update(index, { id: slugifyFieldKey(e.target.value) })}
              disabled={disabled}
              placeholder="schoolName"
            />
          </div>
          <div className={s.fieldHint}>
            <label htmlFor={`pf-label-${index}`} className={s.label}>Label</label>
            <Input
              id={`pf-label-${index}`}
              type="text"
              value={field.label}
              onChange={(e) => update(index, { label: e.target.value })}
              disabled={disabled}
              placeholder="School name"
            />
          </div>
          <div className={s.fieldHint}>
            <label htmlFor={`pf-type-${index}`} className={s.label}>Type</label>
            <Select
              id={`pf-type-${index}`}
              fieldSize="sm"
              value={field.type}
              options={PROFILE_FIELD_TYPE_OPTIONS}
              onChange={(e) => update(index, { type: e.target.value as VisitorProfileField['type'] })}
              disabled={disabled}
            />
          </div>
          <div className={s.fieldHint} style={{ paddingBottom: 'var(--space-2xs)' }}>
            <Switch
              checked={field.required ?? false}
              onCheckedChange={(checked) => update(index, { required: checked })}
              disabled={disabled}
              aria-label={`Required for ${field.label || field.id}`}
            />
          </div>
          <div className={s.fieldHint} style={{ paddingBottom: 'var(--space-2xs)' }}>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              type="button"
              onClick={() => remove(index)}
              disabled={disabled}
              aria-label={`Remove field ${field.label || field.id}`}
            >
              ×
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={add}
          disabled={disabled}
        >
          + Add profile field
        </Button>
      </div>
    </div>
  )
}

/** Slugify a field key: lowercase, alphanumerics + camelCase preserved. */
function slugifyFieldKey(raw: string): string {
  // Keep it a safe JS identifier-ish: strip spaces/symbols, lowercase the first char.
  return raw.replace(/[^A-Za-z0-9]/g, '').replace(/^[A-Z]/, (c) => c.toLowerCase())
}
