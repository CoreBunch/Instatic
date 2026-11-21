/**
 * The member half of the form setup panel: which member action the form
 * performs, what that means, and a button that adds whatever the form still
 * lacks for it.
 */
import { useId } from 'react'
import { MEMBER_FORM_ACTIONS, MEMBER_FORM_GROUP_LABELS, memberFormAction, type MemberFormAction, type MemberFormGroup } from '@core/members'
import { Button } from '@ui/components/Button'
import { ControlRow } from '@ui/components/ControlRow'
import { Select } from '@ui/components/Select'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import type { FormContextSummary } from './formSettingsAnalysis'
import type { MemberFormMissing } from './memberFormParts'
import styles from './FormSettingsPanel.module.css'

const MEMBER_FORM_GROUPS: readonly MemberFormGroup[] = ['entry', 'emailLink', 'account']

/** What the member form still needs, in words, or '' when it is complete. */
function memberMissingText(missing: MemberFormMissing, action: MemberFormAction): string {
  const parts = [
    ...missing.fields.map((field) => field.label.toLowerCase()),
    ...(missing.messages ? [action.successMessage ? 'messages' : 'an error message'] : []),
    ...(missing.submit ? ['a submit button'] : []),
    ...(missing.secondary ? ['a cancel button'] : []),
  ]
  return parts.join(', ')
}

export function MemberActionRow({
  form,
  missing,
  onPatchProps,
  onComplete,
}: {
  form: FormContextSummary
  missing: MemberFormMissing | null
  onPatchProps: (patch: Record<string, unknown>) => void
  onComplete: () => void
}) {
  const selectId = useId()
  const action = memberFormAction(form.memberAction)
  const missingText = missing && action ? memberMissingText(missing, action) : ''

  return (
    <div className={styles.primaryControls}>
      <ControlRow propKey="member-action" inputId={selectId} label="This form" layout="stacked">
        <Select
          id={selectId}
          fieldSize="sm"
          value={action?.action ?? ''}
          onChange={(event) => {
            const next = memberFormAction(event.currentTarget.value)
            // The success message follows the action until the author writes their own.
            if (next) onPatchProps({ memberAction: next.action, successMessage: next.successMessage })
          }}
          data-testid="member-form-action"
        >
          {MEMBER_FORM_GROUPS.map((group) => (
            <optgroup key={group} label={MEMBER_FORM_GROUP_LABELS[group]}>
              {MEMBER_FORM_ACTIONS.filter((entry) => entry.group === group).map((entry) => (
                <option key={entry.action} value={entry.action}>{entry.label}</option>
              ))}
            </optgroup>
          ))}
        </Select>
      </ControlRow>
      {action && (
        <p className={styles.relationship}>
          {action.description}
          {action.linkParam === 'token' && ' Put it on the page you chose for that link in the member settings.'}
          {action.linkParam === 'request' && ' Put it on the page you chose for approving apps in the member settings.'}
          {action.signedIn && ' Show it to signed-in members only.'}
        </p>
      )}
      {missingText && (
        <Button type="button" variant="secondary" size="sm" onClick={onComplete}>
          <PlusIcon size={12} aria-hidden="true" />
          Add {missingText}
        </Button>
      )}
    </div>
  )
}
