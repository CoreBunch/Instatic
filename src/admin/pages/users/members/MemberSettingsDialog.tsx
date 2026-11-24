/**
 * Member settings: who can sign up, which fields a profile has, and which
 * pages of the site the links in member emails open.
 */
import { useId, useState, type FormEvent } from 'react'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import {
  memberPageIsLive,
  memberPageState,
  type MemberPageKey,
  type MemberPageOption,
  type MemberPages,
  type MemberProfileField,
  type MemberSettings,
  type MemberSignupMode,
} from '@core/members'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Switch } from '@ui/components/Switch'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import styles from './Members.module.css'

const FORM_ID = 'member-settings-form'

const SIGNUP_OPTIONS: Array<{ value: MemberSignupMode; label: string }> = [
  { value: 'open', label: 'Open: anyone can sign up' },
  { value: 'invite', label: 'By invitation: only people you invite' },
  { value: 'closed', label: 'Closed: nobody new can sign up' },
]

const SIGNUP_HINT: Record<MemberSignupMode, string> = {
  open: 'A sign-up form on the site creates an account, after the person confirms their email address.',
  invite: 'A sign-up form tells people they need an invitation. Invitations you send from here work.',
  closed: 'A sign-up form tells people sign-up is closed. Invitations you send from here still work.',
}

const FIELD_TYPE_OPTIONS: Array<{ value: MemberProfileField['type']; label: string }> = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'checkbox', label: 'Checkbox' },
]

/**
 * Member features run on pages the owner builds; there are no built-in ones.
 * `hint` says what the page is for, `off` what does not happen while no
 * page is chosen.
 */
const PAGE_FIELDS: Array<{ key: MemberPageKey; label: string; hint: string; off: string }> = [
  {
    key: 'login',
    label: 'Sign-in page',
    hint: 'Where a signed-out visitor is sent when a page is for members.',
    off: 'Not set: a members page answers "not found" to a signed-out visitor.',
  },
  {
    key: 'afterLogin',
    label: 'After signing in',
    hint: 'Where a member lands when nothing else says where to go.',
    off: 'Not set: the home page.',
  },
  {
    key: 'verify',
    label: 'Confirm email',
    hint: 'Opened by the link in the confirmation email. Sign-up needs it.',
    off: 'Not set: sign-up is off.',
  },
  {
    key: 'reset',
    label: 'Choose a new password',
    hint: 'Opened by the link in the password reset email.',
    off: 'Not set: password reset is off.',
  },
  {
    key: 'magic',
    label: 'Sign-in link',
    hint: 'Opened by the link in the sign-in email.',
    off: 'Not set: signing in by emailed link is off.',
  },
  {
    key: 'invite',
    label: 'Accept an invitation',
    hint: 'Opened by an invitation link. Invitations need it.',
    off: 'Not set: invitations are off.',
  },
  {
    key: 'emailChange',
    label: 'Confirm a new email',
    hint: 'Opened by the link sent to a new address.',
    off: 'Not set: members cannot change their address.',
  },
  {
    key: 'appPair',
    label: 'Connect an app by code',
    hint: 'Choose a public page with a Connect an app by code form.',
    off: 'Device approval is off until a page is assigned.',
  },
  {
    key: 'appSignIn',
    label: 'Approve an app',
    hint: 'Where a member is sent when an app asks to sign them in.',
    off: 'Not set: apps cannot sign members in.',
  },
]

/** Why sign-up does not work yet in a mode that needs a page, or null when it does. */
function signupBlocker(mode: MemberSignupMode, pages: MemberPages, options: readonly MemberPageOption[]): string | null {
  if (mode === 'open' && !memberPageIsLive('verify', pages, options)) {
    return 'Sign-up stays off until a published "Confirm email" page is chosen below.'
  }
  if (mode === 'invite' && !memberPageIsLive('invite', pages, options)) {
    return 'Nobody can be invited until a published "Accept an invitation" page is chosen below.'
  }
  return null
}

const NOT_SET = ''

/** What to say under a page picker: a problem with the chosen page, or what the slot is for. */
function pageNote(
  key: MemberPageKey,
  pages: MemberPages,
  options: readonly MemberPageOption[],
  hint: string,
  off: string,
): { text: string; problem: boolean } {
  const state = memberPageState(key, pages, options)
  switch (state.kind) {
    case 'unset':
      return { text: `${hint} ${off}`, problem: false }
    case 'missing':
      return { text: 'The page chosen here was deleted. Choose another.', problem: true }
    case 'unpublished':
      return { text: `"${state.page.title}" is not published yet. This stays off until you publish the site.`, problem: true }
    case 'no_form':
      return {
        text: `No "${state.formLabel}" form was found on "${state.page.title}". Add one in the editor, unless it sits in a component or layout the page uses.`,
        problem: true,
      }
    case 'ready':
      // A signed-out visitor an app sends to an open page can do nothing
      // there; on a members page they are sent to sign in and come back.
      if (key === 'appPair' && state.page.membersOnly) {
        return { text: 'Set this page to public so a member can open the approval email on another device.', problem: true }
      }
      if (key === 'appSignIn' && !state.page.membersOnly) {
        return {
          text: `"${state.page.title}" is open to everyone. Set its Access to signed-in members in the page settings, so a signed-out visitor is sent to sign in first.`,
          problem: true,
        }
      }
      return { text: `${hint} Opens ${state.page.publishedPath}.`, problem: false }
  }
}

const FIELD_ID_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/
const RESERVED_FIELD_IDS = ['email', 'password', 'token', 'currentPassword', 'newPassword']

/** A field id from its label: "Company name" becomes `companyName`. */
function fieldIdFromLabel(label: string): string {
  const words = label.trim().split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const id = words
    .map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join('')
  return id.replace(/^[^a-z]+/, '').slice(0, 40)
}

function fieldProblem(field: MemberProfileField, all: readonly MemberProfileField[]): string | null {
  if (field.label.trim() === '') return 'Give the field a label.'
  if (!FIELD_ID_RE.test(field.id)) return 'The id starts with a lower-case letter and uses letters, digits and _.'
  if (RESERVED_FIELD_IDS.includes(field.id)) return `"${field.id}" is used by the member forms.`
  if (all.filter((other) => other.id === field.id).length > 1) return 'Another field has this id.'
  return null
}

export function MemberSettingsDialog({
  settings,
  pageOptions,
  canEdit,
  busy,
  onClose,
  onSave,
}: {
  settings: MemberSettings
  pageOptions: readonly MemberPageOption[]
  canEdit: boolean
  busy: boolean
  onClose: () => void
  onSave: (settings: MemberSettings) => void
}) {
  const [signupMode, setSignupMode] = useState<MemberSignupMode>(settings.signupMode)
  const [fields, setFields] = useState<MemberProfileField[]>(settings.profileFields)
  const [pages, setPages] = useState<MemberPages>(settings.pages)
  const signupId = useId()
  const idPrefix = useId()

  const fieldProblems = fields.map((field) => fieldProblem(field, fields))
  const pageMissing = PAGE_FIELDS.some(({ key }) => memberPageState(key, pages, pageOptions).kind === 'missing')
  const valid = fieldProblems.every((problem) => problem === null) && !pageMissing
  const pageSelectOptions = [
    { value: NOT_SET, label: 'Not set' },
    ...pageOptions.map((page) => ({ value: page.id, label: `${page.title} (${page.path})` })),
  ]
  const disabled = !canEdit || busy

  function patchField(index: number, patch: Partial<MemberProfileField>) {
    setFields((current) => current.map((field, at) => (at === index ? { ...field, ...patch } : field)))
  }

  function setPage(key: MemberPageKey, pageId: string) {
    setPages((current) => {
      const next = { ...current }
      if (pageId === NOT_SET) delete next[key]
      else next[key] = pageId
      return next
    })
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!valid || disabled) return
    onSave({ signupMode, profileFields: fields.map((field) => ({ ...field, label: field.label.trim() })), pages })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Member settings"
      size="xl"
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            {canEdit ? 'Cancel' : 'Close'}
          </Button>
          {canEdit && (
            <Button variant="primary" size="sm" type="submit" form={FORM_ID} disabled={!valid} busy={busy}>
              Save settings
            </Button>
          )}
        </>
      }
    >
      <form id={FORM_ID} className={dialogStyles.form} onSubmit={handleSubmit}>
        {!canEdit && (
          <p className={dialogStyles.hint}>You can see these settings but your role cannot change them.</p>
        )}

        <div className={dialogStyles.field}>
          <label htmlFor={signupId} className={dialogStyles.label}>Who can sign up</label>
          <Select
            id={signupId}
            fieldSize="sm"
            value={signupMode}
            options={SIGNUP_OPTIONS}
            disabled={disabled}
            onChange={(event) => {
              const next = SIGNUP_OPTIONS.find((option) => option.value === event.currentTarget.value)
              if (next) setSignupMode(next.value)
            }}
          />
          <p className={dialogStyles.hint}>{SIGNUP_HINT[signupMode]}</p>
          {signupBlocker(signupMode, pages, pageOptions) && (
            <p role="status" className={dialogStyles.errorText}>{signupBlocker(signupMode, pages, pageOptions)}</p>
          )}
        </div>

        <fieldset className={dialogStyles.group}>
          <legend className={dialogStyles.groupTitle}>Profile fields</legend>
          <p className={dialogStyles.hint}>
            What a member can tell you about themselves. A form field named with the id fills it, and
            {' '}<code>{'{member.profile.<id>}'}</code> shows it on a page.
          </p>
          {fields.length === 0 && <p className={dialogStyles.hint}>No profile fields. Members have only an email address.</p>}
          {fields.map((field, index) => (
            <div key={index} className={styles.fieldRow} role="group" aria-label={`Profile field ${index + 1}`}>
              <div className={dialogStyles.field}>
                <label htmlFor={`${idPrefix}-label-${index}`} className={dialogStyles.label}>Label</label>
                <Input
                  id={`${idPrefix}-label-${index}`}
                  fieldSize="sm"
                  value={field.label}
                  disabled={disabled}
                  onChange={(event) => {
                    const label = event.target.value
                    // The id follows the label until someone edits the id by hand.
                    const idFollows = field.id === fieldIdFromLabel(field.label)
                    patchField(index, idFollows ? { label, id: fieldIdFromLabel(label) } : { label })
                  }}
                />
              </div>
              <div className={dialogStyles.field}>
                <label htmlFor={`${idPrefix}-id-${index}`} className={dialogStyles.label}>Id</label>
                <Input
                  id={`${idPrefix}-id-${index}`}
                  fieldSize="sm"
                  value={field.id}
                  disabled={disabled}
                  invalid={fieldProblems[index] !== null && field.id !== ''}
                  onChange={(event) => patchField(index, { id: event.target.value.trim() })}
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </div>
              <div className={dialogStyles.field}>
                <label htmlFor={`${idPrefix}-type-${index}`} className={dialogStyles.label}>Type</label>
                <Select
                  id={`${idPrefix}-type-${index}`}
                  fieldSize="sm"
                  value={field.type}
                  options={FIELD_TYPE_OPTIONS}
                  disabled={disabled}
                  onChange={(event) => {
                    const next = FIELD_TYPE_OPTIONS.find((option) => option.value === event.currentTarget.value)
                    if (next) patchField(index, { type: next.value })
                  }}
                />
              </div>
              <label className={styles.requiredToggle}>
                <Switch
                  checked={field.required}
                  disabled={disabled}
                  onCheckedChange={(required) => patchField(index, { required })}
                />
                <span>Required</span>
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`Remove field ${field.label || index + 1}`}
                tooltip="Remove this field"
                disabled={disabled}
                onClick={() => setFields((current) => current.filter((_, at) => at !== index))}
              >
                <TrashSolidIcon size={12} aria-hidden="true" />
              </Button>
              {fieldProblems[index] && (field.label !== '' || field.id !== '') && (
                <p role="alert" className={`${dialogStyles.errorText} ${styles.fieldRowProblem}`}>{fieldProblems[index]}</p>
              )}
            </div>
          ))}
          {canEdit && (
            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy || fields.length >= 30}
                onClick={() => setFields((current) => [...current, { id: '', label: '', type: 'text', required: false }])}
              >
                <PlusIcon size={12} aria-hidden="true" />
                Add a field
              </Button>
            </div>
          )}
        </fieldset>

        <fieldset className={dialogStyles.group}>
          <legend className={dialogStyles.groupTitle}>Member pages</legend>
          <p className={dialogStyles.hint}>
            Member features run on pages you build in the editor. Choose the page for each one. A feature whose
            page is not set, or not published, is switched off.
          </p>
          {pageOptions.length === 0 && (
            <p className={dialogStyles.hint}>This site has no pages yet. Build them in the Site editor first.</p>
          )}
          <div className={styles.pageGrid}>
            {PAGE_FIELDS.map(({ key, label, hint, off }) => {
              const note = pageNote(key, pages, pageOptions, hint, off)
              const deleted = memberPageState(key, pages, pageOptions).kind === 'missing'
              return (
                <div key={key} className={dialogStyles.field}>
                  <label htmlFor={`${idPrefix}-page-${key}`} className={dialogStyles.label}>{label}</label>
                  <Select
                    id={`${idPrefix}-page-${key}`}
                    fieldSize="sm"
                    value={pages[key] ?? NOT_SET}
                    options={deleted
                      ? [...pageSelectOptions, { value: pages[key] ?? NOT_SET, label: 'Deleted page' }]
                      : pageSelectOptions}
                    disabled={disabled}
                    invalid={deleted}
                    onChange={(event) => setPage(key, event.currentTarget.value)}
                  />
                  <p role={note.problem ? 'status' : undefined} className={note.problem ? styles.pageProblem : dialogStyles.hint}>
                    {note.text}
                  </p>
                </div>
              )
            })}
          </div>
        </fieldset>
      </form>
    </Dialog>
  )
}
